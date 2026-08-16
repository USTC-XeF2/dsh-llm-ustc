use crate::config::{IwanConfig, IwanServer};
use crate::iwan::{crypto, gcm};
use anyhow::{Context, Result};
use base64::Engine;
use rand::RngCore;
use reqwest::{Client, Url};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

const AUTH_URL: &str = "https://auth.ivpn.ustc.edu.cn/login/oauth/authorize";
const ISSUER: &str = "https://auth.ivpn.ustc.edu.cn";
const TOKEN_URL: &str = "https://auth.ivpn.ustc.edu.cn/api/login/oauth/access_token";
const CONTROLLER: &str = "https://crtl.ivpn.ustc.edu.cn";
const CLIENT_ID: &str = "afc6479ffb531d71daef";
const REDIRECT: &str = "com.panabit.mobile://oauth2redirect";
const SCOPE: &str = "openid profile email offline_access";
const DOMAIN: &str = "iwan.ustc";
const APP_ID: &str = "controller-ustc";
const APP_SECRET: &str = "ca6a3532abd2986a03b86b3a";
const TRANSACTION_TTL: Duration = Duration::from_secs(10 * 60);

struct Transaction {
    verifier: String,
    issuer: String,
    expires_at: Instant,
}

#[derive(Default)]
pub(crate) struct OidcTransactions {
    pending: Mutex<HashMap<String, Transaction>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OidcBegin {
    pub auth_url: String,
    pub expires_in_seconds: u64,
}

impl OidcTransactions {
    pub(crate) async fn begin(&self) -> OidcBegin {
        let mut random = [0u8; 64];
        rand::thread_rng().fill_bytes(&mut random);
        let verifier = gcm::b64url_no_pad(&random);
        let challenge = gcm::b64url_no_pad(&crypto::sha256(verifier.as_bytes()));
        let state = random_text(32);
        let mut url = Url::parse(AUTH_URL).expect("constant auth URL");
        url.query_pairs_mut()
            .append_pair("client_id", CLIENT_ID)
            .append_pair("redirect_uri", REDIRECT)
            .append_pair("response_type", "code")
            .append_pair("scope", SCOPE)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state);
        let mut pending = self.pending.lock().await;
        pending.retain(|_, transaction| transaction.expires_at > Instant::now());
        pending.insert(
            state,
            Transaction {
                verifier,
                issuer: ISSUER.into(),
                expires_at: Instant::now() + TRANSACTION_TTL,
            },
        );
        OidcBegin {
            auth_url: url.into(),
            expires_in_seconds: TRANSACTION_TTL.as_secs(),
        }
    }

    pub(crate) async fn complete(&self, client: &Client, callback: &str) -> Result<IwanConfig> {
        let (code, transaction) = self.take_transaction(callback).await?;
        let token_request = serde_json::to_vec(&json!({
            "client_id": CLIENT_ID,
            "code": code,
            "code_verifier": transaction.verifier,
            "redirect_uri": REDIRECT,
            "grant_type": "authorization_code"
        }))?;
        let token: Value = checked_json(
            client
                .post(TOKEN_URL)
                .header("content-type", "application/json")
                .body(token_request)
                .send()
                .await?,
        )
        .await
        .context("exchange OIDC code")?;
        let access = token
            .get("access_token")
            .and_then(Value::as_str)
            .context("OIDC response has no access token")?;
        let username = token
            .get("id_token")
            .and_then(Value::as_str)
            .and_then(username_from_id_token)
            .unwrap_or_else(|| "unknown".into());
        fetch_servers(client, access, &username).await
    }

    async fn take_transaction(&self, callback: &str) -> Result<(String, Transaction)> {
        let url = Url::parse(callback).context("invalid callback URL")?;
        if url.scheme() != "com.panabit.mobile" || url.host_str() != Some("oauth2redirect") {
            anyhow::bail!("callback URL has an unexpected scheme or target");
        }
        let values: HashMap<String, String> = url
            .query_pairs()
            .map(|(k, v)| (k.into(), v.into()))
            .collect();
        let state = values.get("state").context("callback URL has no state")?;
        let code = values
            .get("code")
            .context("callback URL has no authorization code")?;
        let transaction = self
            .pending
            .lock()
            .await
            .remove(state)
            .context("OIDC transaction is missing or already consumed")?;
        if transaction.expires_at <= Instant::now() {
            anyhow::bail!("OIDC transaction expired");
        }
        if values
            .get("iss")
            .is_some_and(|issuer| issuer.trim_end_matches('/') != transaction.issuer)
        {
            anyhow::bail!("callback URL has an unexpected issuer");
        }
        Ok((code.clone(), transaction))
    }
}

async fn fetch_servers(client: &Client, access: &str, username: &str) -> Result<IwanConfig> {
    let device_id = random_hex(8);
    let body = json!({
        "domain": DOMAIN, "type": "android", "oem_name": "panabit",
        "device_id": device_id, "userName": username,
        "serverlist_version": "0", "ipfilter_version": "0", "branding_version": "0"
    });
    controller_post(client, "/m/auth", &body, access).await?;
    let mut keepalive = body.clone();
    keepalive["type"] = Value::String("keepalive".into());
    controller_post(client, "/m/keepalive", &keepalive, access).await?;
    let response = controller_post(client, "/m/config", &body, access).await?;
    let list = response
        .pointer("/serverlist/serverlist")
        .and_then(Value::as_array)
        .context("controller response has no server list")?;
    let servers = list
        .iter()
        .enumerate()
        .map(|(index, server)| {
            let host = string_field(server, "serverName")?;
            let port = server
                .get("serverPort")
                .and_then(Value::as_u64)
                .unwrap_or(6001) as u16;
            let username = string_field(server, "userName")?;
            let name = string_field(server, "name")?;
            let pass_word = string_field(server, "passWord")?;
            let id = stable_server_id(index, &host, port, &username);
            Ok(IwanServer {
                id,
                name,
                host,
                port,
                username,
                pass_word,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let config = IwanConfig {
        domain: DOMAIN.into(),
        servers,
    };
    config.validate()?;
    Ok(config)
}

async fn controller_post(client: &Client, path: &str, body: &Value, access: &str) -> Result<Value> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_secs()
        .to_string();
    let nonce = random_hex(16).to_uppercase();
    let bytes = serde_json::to_vec(body)?;
    let canonical = format!(
        "POST\n{path}\n\n{}\n{timestamp}\n{nonce}",
        crypto::hex(&crypto::sha256(&bytes))
    );
    let signature = crypto::hex(&crypto::hmac_sha256(
        APP_SECRET.as_bytes(),
        canonical.as_bytes(),
    ));
    let response = client
        .post(format!("{CONTROLLER}{path}"))
        .header("Authorization", format!("Bearer {access}"))
        .header("X-Auth-AppId", APP_ID)
        .header("X-Auth-Timestamp", timestamp)
        .header("X-Auth-Nonce", nonce)
        .header("X-Auth-Sign", signature)
        .header("content-type", "application/json")
        .body(bytes)
        .send()
        .await?;
    checked_json(response)
        .await
        .with_context(|| format!("controller request {path}"))
}

async fn checked_json(response: reqwest::Response) -> Result<Value> {
    let status = response.status();
    let bytes = response.bytes().await?;
    if !status.is_success() {
        anyhow::bail!("HTTP {}", status.as_u16());
    }
    serde_json::from_slice(&bytes).context("parse JSON response")
}

fn username_from_id_token(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    ["name", "preferred_username", "sub"]
        .iter()
        .find_map(|key| value.get(key).and_then(Value::as_str).map(str::to_owned))
}

fn stable_server_id(index: usize, host: &str, port: u16, username: &str) -> String {
    let digest = Sha256::digest(format!("{index}\0{host}\0{port}\0{username}").as_bytes());
    format!("line-{}", &crypto::hex(&digest)[..16])
}

fn string_field(value: &Value, key: &str) -> Result<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .with_context(|| format!("server has no {key}"))
}

fn random_text(len: usize) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut random = rand::thread_rng();
    (0..len)
        .map(|_| ALPHABET[random.next_u32() as usize % ALPHABET.len()] as char)
        .collect()
}

fn random_hex(bytes: usize) -> String {
    let mut value = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut value);
    crypto::hex(&value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn oidc_state_is_single_use_and_pkce_is_s256() {
        let transactions = OidcTransactions::default();
        let begin = transactions.begin().await;
        let auth = Url::parse(&begin.auth_url).unwrap();
        let query: HashMap<String, String> = auth
            .query_pairs()
            .map(|(k, v)| (k.into(), v.into()))
            .collect();
        let state = query.get("state").unwrap();
        assert_eq!(
            query.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        assert!(
            query
                .get("code_challenge")
                .is_some_and(|value| !value.is_empty())
        );
        let callback =
            format!("com.panabit.mobile://oauth2redirect?state={state}&code=one-time-code");

        let (code, _) = transactions.take_transaction(&callback).await.unwrap();
        assert_eq!(code, "one-time-code");
        let error = match transactions.take_transaction(&callback).await {
            Ok(_) => panic!("OIDC state was accepted twice"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("already consumed"));
    }

    #[tokio::test]
    async fn expired_oidc_state_is_rejected_and_consumed() {
        let transactions = OidcTransactions::default();
        transactions.pending.lock().await.insert(
            "expired".into(),
            Transaction {
                verifier: "verifier".into(),
                issuer: ISSUER.into(),
                expires_at: Instant::now() - Duration::from_secs(1),
            },
        );
        let callback = "com.panabit.mobile://oauth2redirect?iss=https%3A%2F%2Fauth.ivpn.ustc.edu.cn&state=expired&code=code";
        let expired = match transactions.take_transaction(callback).await {
            Ok(_) => panic!("expired OIDC state was accepted"),
            Err(error) => error,
        };
        assert!(expired.to_string().contains("expired"));
        let consumed = match transactions.take_transaction(callback).await {
            Ok(_) => panic!("expired OIDC state was accepted twice"),
            Err(error) => error,
        };
        assert!(consumed.to_string().contains("already consumed"));
    }

    #[tokio::test]
    async fn rejects_a_callback_with_a_different_issuer() {
        let transactions = OidcTransactions::default();
        let begin = transactions.begin().await;
        let auth = Url::parse(&begin.auth_url).unwrap();
        let state = auth
            .query_pairs()
            .find_map(|(key, value)| (key == "state").then(|| value.into_owned()))
            .unwrap();
        let callback = format!(
            "com.panabit.mobile://oauth2redirect?iss=https%3A%2F%2Fevil.example&state={state}&code=code"
        );
        let error = match transactions.take_transaction(&callback).await {
            Ok(_) => panic!("callback with a different issuer was accepted"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("unexpected issuer"));
    }
}
