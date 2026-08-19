use serde::Deserialize;

pub(crate) const TARGET_HOST: &str = "api.llm.ustc.edu.cn";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartupConfig {
    pub session_token: String,
    #[serde(default)]
    pub tunnel: Option<TunnelConfig>,
    #[serde(default = "default_direct_recovery_seconds")]
    pub direct_recovery_seconds: u64,
}

fn default_direct_recovery_seconds() -> u64 {
    300
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TunnelConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

impl TunnelConfig {
    pub(crate) fn validate(&self) -> anyhow::Result<()> {
        if self.host.parse::<std::net::Ipv4Addr>().is_err()
            || self.port == 0
            || self.username.is_empty()
            || self.password.is_empty()
        {
            anyhow::bail!("iWAN tunnel configuration is invalid");
        }
        Ok(())
    }
}
