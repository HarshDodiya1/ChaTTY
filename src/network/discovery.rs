use anyhow::{Context, Result};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use std::collections::HashMap;
use std::net::{IpAddr, UdpSocket};
use tokio::sync::mpsc;

pub const SERVICE_TYPE: &str = "_chatty._tcp.local.";

#[derive(Debug, Clone)]
pub enum DiscoveryEvent {
    PeerFound {
        user_id: String,
        username: String,
        display_name: String,
        ip: IpAddr,
        port: u16,
    },
    PeerLost {
        user_id: String,
    },
}

pub struct DiscoveryService {
    daemon: ServiceDaemon,
    username: String,
    port: u16,
    user_id: String,
    service_name: String,
}

impl DiscoveryService {
    pub fn new(username: String, port: u16, user_id: String) -> Result<Self> {
        let daemon = ServiceDaemon::new().with_context(|| "Failed to create mDNS daemon")?;
        // Use user_id as the instance name — guaranteed unique even if two users share a username.
        let service_name = format!("{}.{}", user_id, SERVICE_TYPE);
        Ok(DiscoveryService {
            daemon,
            username,
            port,
            user_id,
            service_name,
        })
    }

    /// Register this peer as an mDNS service so others can discover us.
    pub fn start_advertising(&self) -> Result<()> {
        log::info!("mDNS: Advertising service '{}' on port {}", self.service_name, self.port);
        let mut props = HashMap::new();
        props.insert("user_id".to_string(), self.user_id.clone());
        props.insert("username".to_string(), self.username.clone());
        props.insert("display_name".to_string(), self.username.clone());

        let host = format!("{}.local.", gethostname());

        // Detect primary LAN IP — "no address" (`()`) makes the daemon unable to respond
        let my_ip = get_primary_lan_ip();
        log::info!("mDNS: Using host='{}', ip={} for service registration", host, my_ip);

        let service = ServiceInfo::new(
            SERVICE_TYPE,
            &self.user_id,   // unique instance name — avoids conflicts on same username
            &host,
            my_ip,
            self.port,
            props,
        )
        .with_context(|| "Failed to build mDNS ServiceInfo")?;

        self.daemon
            .register(service)
            .with_context(|| "Failed to register mDNS service")?;

        log::info!("mDNS: Service registered successfully");
        Ok(())
    }

    /// Browse for peers and send events through `tx`.
    /// This spawns a blocking thread internally (mdns-sd is synchronous).
    pub fn start_browsing(&self, tx: mpsc::Sender<DiscoveryEvent>) -> Result<()> {
        log::info!("mDNS: Starting to browse for service type: {}", SERVICE_TYPE);
        let receiver = self
            .daemon
            .browse(SERVICE_TYPE)
            .with_context(|| "Failed to start mDNS browse")?;

        let own_user_id = self.user_id.clone();

        std::thread::spawn(move || {
            log::info!("mDNS: Browse thread started, waiting for events...");
            while let Ok(event) = receiver.recv() {
                match event {
                    ServiceEvent::SearchStarted(stype) => {
                        log::info!("mDNS: SearchStarted for {}", stype);
                    }
                    ServiceEvent::ServiceFound(stype, fullname) => {
                        log::info!("mDNS: ServiceFound type={} name={}", stype, fullname);
                    }
                    ServiceEvent::ServiceResolved(info) => {
                        let props = info.get_properties();
                        let user_id = props
                            .get_property_val_str("user_id")
                            .unwrap_or_default()
                            .to_string();

                        // Skip our own advertisement
                        if user_id == own_user_id {
                            continue;
                        }

                        let username = props
                            .get_property_val_str("username")
                            .unwrap_or("unknown")
                            .to_string();
                        let display_name = props
                            .get_property_val_str("display_name")
                            .unwrap_or(&username)
                            .to_string();
                        let port = info.get_port();

                        // Pick first resolved address
                        if let Some(&ip) = info.get_addresses().iter().next() {
                            log::info!(
                                "mDNS: Discovered peer '{}' (id={}) at {}:{}",
                                username, user_id, ip, port
                            );
                            let ev = DiscoveryEvent::PeerFound {
                                user_id,
                                username,
                                display_name,
                                ip,
                                port,
                            };
                            if tx.blocking_send(ev).is_err() {
                                break;
                            }
                        }
                    }
                    ServiceEvent::ServiceRemoved(_ty, fullname) => {
                        log::info!("mDNS: Service removed: {}", fullname);
                        // fullname is "<instance>.<type>" — extract user_id from it
                        // We don't have it directly, so send fullname as user_id placeholder.
                        let ev = DiscoveryEvent::PeerLost {
                            user_id: fullname,
                        };
                        if tx.blocking_send(ev).is_err() {
                            break;
                        }
                    }
                    other => {
                        log::debug!("mDNS: Other event: {:?}", other);
                    }
                }
            }
            log::warn!("mDNS: Browse thread exiting — receiver channel closed");
        });

        Ok(())
    }

    /// Unregister the mDNS service for clean shutdown.
    pub fn stop(&self) -> Result<()> {
        self.daemon
            .unregister(&self.service_name)
            .with_context(|| "Failed to unregister mDNS service")?;
        Ok(())
    }
}

/// Return the system hostname for use in mDNS SRV records.
/// Tries multiple sources so it works on both Linux and macOS.
fn gethostname() -> String {
    // 1. Linux: /etc/hostname
    if let Ok(h) = std::fs::read_to_string("/etc/hostname") {
        let h = h.trim().to_string();
        if !h.is_empty() {
            return h;
        }
    }
    // 2. Shell environment variable (set by bash/zsh on many systems)
    if let Ok(h) = std::env::var("HOSTNAME") {
        if !h.is_empty() {
            return h;
        }
    }
    // 3. `hostname` command — works on macOS, BSD, and most Linux distros
    if let Ok(out) = std::process::Command::new("hostname").output() {
        let h = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !h.is_empty() {
            return h;
        }
    }
    "localhost".to_string()
}

/// Detect the primary LAN-facing IPv4 address(es).
///
/// Opens a UDP socket toward an external address (no packets are sent)
/// to determine which local interface the OS would use for LAN traffic.
/// Falls back to 127.0.0.1 if detection fails.
fn get_primary_lan_ip() -> IpAddr {
    // Try to find the outbound LAN IP by "connecting" a UDP socket.
    // This doesn't actually send anything; the OS just picks the right interface.
    if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
        // 8.8.8.8:80 forces the OS to choose the default outbound interface.
        if sock.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = sock.local_addr() {
                let ip = addr.ip();
                if !ip.is_loopback() {
                    log::info!("Detected primary LAN IP: {}", ip);
                    return ip;
                }
            }
        }
    }
    log::warn!("Could not detect LAN IP, falling back to 0.0.0.0");
    IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED)
}
