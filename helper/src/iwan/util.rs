use std::sync::OnceLock;

pub fn debug_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("IWAN_DEBUG")
            .map(|value| !matches!(value.as_str(), "" | "0" | "false" | "off"))
            .unwrap_or(false)
    })
}
