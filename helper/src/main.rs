mod config;
mod iwan;
mod oidc;
mod server;
mod tunnel;

use anyhow::{Context, Result};
use config::StartupConfig;
use serde::Serialize;
use std::io::{BufRead, Write};
use tokio::sync::oneshot;

#[derive(Serialize)]
struct Handshake {
    protocol: &'static str,
    port: u16,
    pid: u32,
}

#[tokio::main]
async fn main() -> Result<()> {
    let (config, stdin_closed) = read_startup()?;
    let state = server::AppState::new(config)?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .context("bind loopback helper")?;
    let port = listener.local_addr()?.port();
    println!(
        "{}",
        serde_json::to_string(&Handshake {
            protocol: "v1",
            port,
            pid: std::process::id()
        })?
    );
    std::io::stdout().flush().ok();
    server::start_reprobe(state.clone());
    let shutdown = async move {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = stdin_closed => {},
        }
    };
    axum::serve(listener, server::router(state))
        .with_graceful_shutdown(shutdown)
        .await?;
    Ok(())
}

fn read_startup() -> Result<(StartupConfig, oneshot::Receiver<()>)> {
    let mut first_line = String::new();
    std::io::stdin()
        .read_line(&mut first_line)
        .context("read startup configuration")?;
    if first_line.len() > 4 * 1024 * 1024 {
        anyhow::bail!("startup configuration is too large");
    }
    let config = serde_json::from_str(&first_line).context("parse startup configuration")?;
    let (closed_tx, closed_rx) = oneshot::channel();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut locked = stdin.lock();
        let mut sink = String::new();
        while locked.read_line(&mut sink).is_ok_and(|length| length > 0) {
            sink.clear();
        }
        let _ = closed_tx.send(());
    });
    Ok((config, closed_rx))
}
