use anyhow::{Context, Result};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use std::collections::HashMap;
use std::net::IpAddr;
use tokio::sync::mpsc;

pub const SERVICE_TYPE: &str = "_ChaTTY._tcp.local.";

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
        // Service instance name must be unique — use the user_id slug
        let service_name = format!("{}.{}", username, SERVICE_TYPE);
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
        let mut props = HashMap::new();
        props.insert("user_id".to_string(), self.user_id.clone());
        props.insert("username".to_string(), self.username.clone());
        props.insert("display_name".to_string(), self.username.clone());

        let service = ServiceInfo::new(
            SERVICE_TYPE,
            &self.username,
            &format!("{}.local.", gethostname()),
            (),
            self.port,
            props,
        )
        .with_context(|| "Failed to build mDNS ServiceInfo")?;

        self.daemon
            .register(service)
            .with_context(|| "Failed to register mDNS service")?;

        Ok(())
    }

    /// Browse for peers and send events through `tx`.
    /// This spawns a blocking thread internally (mdns-sd is synchronous).
    pub fn start_browsing(&self, tx: mpsc::Sender<DiscoveryEvent>) -> Result<()> {
        let receiver = self
            .daemon
            .browse(SERVICE_TYPE)
            .with_context(|| "Failed to start mDNS browse")?;

        let own_user_id = self.user_id.clone();

        std::thread::spawn(move || {
            while let Ok(event) = receiver.recv() {
                match event {
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
                        // fullname is "<instance>.<type>" — extract user_id from it
                        // We don't have it directly, so send fullname as user_id placeholder.
                        let ev = DiscoveryEvent::PeerLost {
                            user_id: fullname,
                        };
                        if tx.blocking_send(ev).is_err() {
                            break;
                        }
                    }
                    _ => {}
                }
            }
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

/// Return the system hostname (used as the mDNS host name).
fn gethostname() -> String {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "localhost".to_string())
}
