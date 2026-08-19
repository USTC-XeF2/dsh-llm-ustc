use crate::config::TunnelConfig;
use crate::iwan::{auth, crypto, socks};
use anyhow::{Context, Result};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;
use std::time::Duration;

pub(crate) struct TunnelHandle {
    pub address: SocketAddr,
    running: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl TunnelHandle {
    pub(crate) fn is_finished(&self) -> bool {
        self.thread.as_ref().is_none_or(JoinHandle::is_finished)
    }
}

impl Drop for TunnelHandle {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub(crate) fn start(config: &TunnelConfig) -> Result<TunnelHandle> {
    let config = config.clone();
    let running = Arc::new(AtomicBool::new(true));
    let worker_running = running.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (error_tx, error_rx) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("dsh-ustc-iwan".into())
        .spawn(move || {
            let result = run_line(&config, worker_running, ready_tx);
            if let Err(error) = &result {
                eprintln!("iWAN data path stopped: {error:#}");
            }
            let _ = error_tx.send(result.map(|_| ()));
        })
        .context("spawn iWAN data path")?;
    let address = match ready_rx.recv_timeout(Duration::from_secs(8)) {
        Ok(address) => address,
        Err(_) => {
            running.store(false, Ordering::Relaxed);
            let detail = error_rx
                .try_recv()
                .ok()
                .and_then(Result::err)
                .map(|error| format!(": {error:#}"))
                .unwrap_or_default();
            let _ = thread.join();
            anyhow::bail!("iWAN line did not become ready{detail}");
        }
    };
    Ok(TunnelHandle {
        address,
        running,
        thread: Some(thread),
    })
}

fn run_line(
    config: &TunnelConfig,
    running: Arc<AtomicBool>,
    ready: mpsc::Sender<SocketAddr>,
) -> Result<()> {
    let encrypted_password = crypto::encrypt_password(&config.password, &config.username);
    let nonce = rand::random();
    let open = auth::build_open(&config.username, &encrypted_password, 1380, 1, nonce);
    let address: SocketAddr = format!("{}:{}", config.host, config.port)
        .parse()
        .context("invalid iWAN server address")?;
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").context("bind iWAN UDP socket")?;
    socket.connect(address).context("connect iWAN UDP socket")?;
    socket
        .set_read_timeout(Some(Duration::from_millis(1_500)))
        .ok();
    let authenticated = authenticate(&socket, &open, nonce, &running)?;
    let inner_ip = authenticated
        .tun
        .parse()
        .context("invalid tunnel IPv4 address")?;
    let gateway = authenticated.gw.parse().context("invalid tunnel gateway")?;
    let session_key = crypto::session_key(&config.username, &config.password);
    socks::run(
        &socket,
        socks::SocksConfig {
            listen: "127.0.0.1:0".parse().expect("constant loopback address"),
            inner_ip,
            gateway,
            mtu: usize::from(authenticated.mtu.min(1380)),
            xor_key: &session_key[..8],
            sid: authenticated.sid,
            token: authenticated.tok,
            encryption: 1,
        },
        running,
        ready,
    )
}

fn authenticate(
    socket: &std::net::UdpSocket,
    open: &[u8],
    nonce: u32,
    running: &AtomicBool,
) -> Result<auth::AuthResult> {
    for attempt in 0..3 {
        if !running.load(Ordering::Relaxed) {
            anyhow::bail!("iWAN startup cancelled");
        }
        socket.send(open).context("send iWAN OPEN")?;
        let mut response = [0u8; 4096];
        match socket.recv(&mut response) {
            Ok(length) => match auth::parse_ack(&response[..length], nonce) {
                Ok(result) => return Ok(result),
                Err(error) if attempt == 2 => {
                    return Err(error).context("invalid iWAN authentication response");
                }
                Err(_) => {}
            },
            Err(error) if attempt == 2 => {
                return Err(error).context("iWAN authentication timed out");
            }
            Err(_) => {}
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    anyhow::bail!("iWAN authentication failed")
}
