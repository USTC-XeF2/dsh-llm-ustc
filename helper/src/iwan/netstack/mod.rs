pub(crate) mod device;
pub(crate) mod dns;
pub(crate) mod tunnel;

pub(crate) use device::IpTunnelDevice;
pub(crate) use dns::{DNS_SERVER, DnsResult, spawn_ipv4_query};
pub(crate) use tunnel::{VPN_KEEPALIVE_INTERVAL, receive_vpn, send_vpn, send_vpn_keepalive};
