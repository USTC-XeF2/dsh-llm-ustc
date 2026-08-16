use serde::{Deserialize, Serialize};

pub(crate) const TARGET_HOST: &str = "api.llm.ustc.edu.cn";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartupConfig {
    pub session_token: String,
    #[serde(default)]
    pub iwan_config: Option<IwanConfig>,
    #[serde(default)]
    pub selected_server_id: Option<String>,
    #[serde(default = "default_reprobe_seconds")]
    pub direct_reprobe_seconds: u64,
}

fn default_reprobe_seconds() -> u64 {
    300
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct IwanConfig {
    #[serde(default = "default_domain")]
    pub domain: String,
    pub servers: Vec<IwanServer>,
}

fn default_domain() -> String {
    "iwan.ustc".to_string()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IwanServer {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub pass_word: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicServer {
    pub id: String,
    pub name: String,
    pub endpoint: String,
}

impl IwanConfig {
    pub(crate) fn validate(&self) -> anyhow::Result<()> {
        if self.domain.is_empty() || self.servers.is_empty() {
            anyhow::bail!("iWAN configuration has no usable servers");
        }
        for server in &self.servers {
            if server.id.is_empty()
                || server.name.is_empty()
                || server.host.parse::<std::net::Ipv4Addr>().is_err()
                || server.port == 0
                || server.username.is_empty()
                || server.pass_word.is_empty()
            {
                anyhow::bail!("iWAN configuration contains an invalid server");
            }
        }
        Ok(())
    }

    pub(crate) fn public_servers(&self) -> Vec<PublicServer> {
        self.servers
            .iter()
            .map(|server| PublicServer {
                id: server.id.clone(),
                name: server.name.clone(),
                endpoint: format!("{}:{}", server.host, server.port),
            })
            .collect()
    }
}
