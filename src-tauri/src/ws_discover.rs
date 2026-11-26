use serde::Serialize;
use std::collections::{HashSet, VecDeque};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream, ToSocketAddrs, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredWebSocket {
    pub name: String,
    pub url: String,
    pub host: String,
    pub port: u16,
    pub path: String,
    pub is_local: bool,
}

const LOCAL_PORTS: &[u16] = &[
    9002, 9001, 9000, 9003, 9004, 9005, 6677, 6678, 2333, 2334, 8080, 27080,
];
const LAN_PORTS: &[u16] = &[
    9002, 9001, 9000, 9003, 9004, 9005, 6677, 6678, 2333, 8080, 27080,
];
const IO_TIMEOUT: Duration = Duration::from_millis(450);

#[derive(Clone, Debug)]
struct ProbeTarget {
    addr: SocketAddr,
    host_label: String,
    is_local: bool,
    connect_timeout: Duration,
}

#[derive(Debug, PartialEq, Eq)]
enum PathProbeOutcome {
    Unreachable,
    Upgraded,
    Rejected,
}

/// Checks whether an HTTP response is a valid RFC 6455 `101 Switching Protocols` upgrade.
pub fn is_ws_upgrade_response(raw: &str) -> bool {
    let mut lines = raw.lines();
    let Some(status_line) = lines.next() else {
        return false;
    };
    let status_lower = status_line.trim().to_ascii_lowercase();
    if !(status_lower.starts_with("http/1.1 101") || status_lower.starts_with("http/1.0 101")) {
        return false;
    }
    let headers_lower = raw.to_ascii_lowercase();
    headers_lower.contains("upgrade: websocket") || headers_lower.contains("sec-websocket-accept:")
}

/// Detects this machine's private RFC 1918 IPv4 address via routing table inspection (no packets sent).
pub fn detect_local_ipv4() -> Option<Ipv4Addr> {
    for target in ["8.8.8.8:80", "1.1.1.1:80", "192.168.0.1:80"] {
        if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
            if socket.connect(target).is_ok() {
                if let Ok(addr) = socket.local_addr() {
                    if let IpAddr::V4(ip) = addr.ip() {
                        if ip.is_private() && !ip.is_loopback() {
                            return Some(ip);
                        }
                    }
                }
            }
        }
    }
    None
}

/// Returns all 254 host addresses in the `/24` subnet of a private IPv4 address.
pub fn lan_subnet_hosts(local_ip: Ipv4Addr) -> Vec<Ipv4Addr> {
    if !local_ip.is_private() || local_ip.is_loopback() {
        return Vec::new();
    }
    let [a, b, c, _] = local_ip.octets();
    (1u8..=254u8)
        .map(|d| Ipv4Addr::new(a, b, c, d))
        .collect()
}

fn send_ws_upgrade(
    addr: SocketAddr,
    host_header: &str,
    path: &str,
    connect_timeout: Duration,
    io_timeout: Duration,
) -> PathProbeOutcome {
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, connect_timeout) else {
        return PathProbeOutcome::Unreachable;
    };
    let _ = stream.set_read_timeout(Some(io_timeout));
    let _ = stream.set_write_timeout(Some(io_timeout));

    let req = format!(
        "GET {path} HTTP/1.1\r\n\
         Host: {host_header}\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
         Sec-WebSocket-Version: 13\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return PathProbeOutcome::Rejected;
    }

    let mut buf = [0u8; 1024];
    let n = match stream.read(&mut buf) {
        Ok(n) if n > 0 => n,
        _ => return PathProbeOutcome::Rejected,
    };
    let raw = String::from_utf8_lossy(&buf[..n]);
    if is_ws_upgrade_response(&raw) {
        PathProbeOutcome::Upgraded
    } else {
        PathProbeOutcome::Rejected
    }
}

/// Probes an endpoint with a WebSocket HTTP upgrade on `/` (Agent/Textractor) and
/// falls back to `/api/text/origin` (LunaTranslator) only when TCP connects and `/` rejects.
pub fn probe_ws_endpoint(
    addr: SocketAddr,
    host_label: &str,
    is_local: bool,
    connect_timeout: Duration,
) -> Option<DiscoveredWebSocket> {
    let port = addr.port();
    let host_header = format!("{host_label}:{port}");

    match send_ws_upgrade(addr, &host_header, "/", connect_timeout, IO_TIMEOUT) {
        PathProbeOutcome::Upgraded => {
            return Some(DiscoveredWebSocket {
                name: if is_local {
                    "Agent / Textractor".to_string()
                } else {
                    format!("Agent / Textractor ({host_label})")
                },
                url: format!("ws://{host_label}:{port}"),
                host: host_label.to_string(),
                port,
                path: String::new(),
                is_local,
            });
        }
        PathProbeOutcome::Unreachable => return None,
        PathProbeOutcome::Rejected => {}
    }

    if send_ws_upgrade(
        addr,
        &host_header,
        "/api/text/origin",
        connect_timeout,
        IO_TIMEOUT,
    ) == PathProbeOutcome::Upgraded
    {
        return Some(DiscoveredWebSocket {
            name: if is_local {
                "LunaTranslator".to_string()
            } else {
                format!("LunaTranslator ({host_label})")
            },
            url: format!("ws://{host_label}:{port}/api/text/origin"),
            host: host_label.to_string(),
            port,
            path: "/api/text/origin".to_string(),
            is_local,
        });
    }

    None
}

fn resolve_extra_ipv4(host: &str) -> Option<Ipv4Addr> {
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        return Some(ip);
    }
    (host, 0)
        .to_socket_addrs()
        .ok()?
        .find_map(|addr| match addr {
            SocketAddr::V4(v4) => Some(*v4.ip()),
            SocketAddr::V6(_) => None,
        })
}

/// Discovers active text-hooker WebSocket servers on localhost, explicit hosts, and the local `/24` LAN.
#[tauri::command]
pub async fn discover_websocket_sources(
    extra_hosts: Option<Vec<String>>,
    scan_lan: Option<bool>,
) -> Result<Vec<DiscoveredWebSocket>, String> {
    tokio::task::spawn_blocking(move || {
        let local_ip = detect_local_ipv4();
        let loopback = Ipv4Addr::new(127, 0, 0, 1);
        let mut targets: Vec<ProbeTarget> = Vec::new();
        let mut queued_local_ips: HashSet<Ipv4Addr> = HashSet::new();

        queued_local_ips.insert(loopback);
        for &port in LOCAL_PORTS {
            targets.push(ProbeTarget {
                addr: SocketAddr::V4(SocketAddrV4::new(loopback, port)),
                host_label: "127.0.0.1".to_string(),
                is_local: true,
                connect_timeout: Duration::from_millis(350),
            });
        }

        if let Some(ip) = local_ip {
            if queued_local_ips.insert(ip) {
                let host_label = ip.to_string();
                for &port in LOCAL_PORTS {
                    targets.push(ProbeTarget {
                        addr: SocketAddr::V4(SocketAddrV4::new(ip, port)),
                        host_label: host_label.clone(),
                        is_local: true,
                        connect_timeout: Duration::from_millis(250),
                    });
                }
            }
        }

        if let Some(hosts) = extra_hosts {
            for raw_host in hosts {
                let trimmed = raw_host.trim();
                if trimmed.is_empty()
                    || trimmed.eq_ignore_ascii_case("localhost")
                    || trimmed == "127.0.0.1"
                {
                    continue;
                }
                let Some(ip) = resolve_extra_ipv4(trimmed) else {
                    continue;
                };
                if !queued_local_ips.insert(ip) {
                    continue;
                }
                let is_local = ip.is_loopback() || Some(ip) == local_ip;
                for &port in LOCAL_PORTS {
                    targets.push(ProbeTarget {
                        addr: SocketAddr::V4(SocketAddrV4::new(ip, port)),
                        host_label: trimmed.to_string(),
                        is_local,
                        connect_timeout: Duration::from_millis(350),
                    });
                }
            }
        }

        if scan_lan.unwrap_or(true) {
            if let Some(own_ip) = local_ip {
                for ip in lan_subnet_hosts(own_ip) {
                    if queued_local_ips.contains(&ip) {
                        continue;
                    }
                    let host_label = ip.to_string();
                    for &port in LAN_PORTS {
                        targets.push(ProbeTarget {
                            addr: SocketAddr::V4(SocketAddrV4::new(ip, port)),
                            host_label: host_label.clone(),
                            is_local: false,
                            connect_timeout: Duration::from_millis(160),
                        });
                    }
                }
            }
        }

        let worker_count = std::cmp::min(96, targets.len());
        let queue = Arc::new(Mutex::new(VecDeque::from(targets)));
        let found = Arc::new(Mutex::new(Vec::<DiscoveredWebSocket>::new()));

        let mut handles = Vec::with_capacity(worker_count);
        for _ in 0..worker_count {
            let queue = Arc::clone(&queue);
            let found = Arc::clone(&found);
            handles.push(std::thread::spawn(move || loop {
                let next = {
                    let mut guard = match queue.lock() {
                        Ok(g) => g,
                        Err(_) => return,
                    };
                    guard.pop_front()
                };
                let Some(target) = next else {
                    return;
                };
                if let Some(hit) = probe_ws_endpoint(
                    target.addr,
                    &target.host_label,
                    target.is_local,
                    target.connect_timeout,
                ) {
                    if let Ok(mut guard) = found.lock() {
                        guard.push(hit);
                    }
                }
            }));
        }

        for handle in handles {
            let _ = handle.join();
        }

        let mut results = found
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        let local_hits: HashSet<(u16, String)> = results
            .iter()
            .filter(|item| item.host == "127.0.0.1")
            .map(|item| (item.port, item.path.clone()))
            .collect();

        let own_ip_str = local_ip.map(|ip| ip.to_string());
        let mut seen_urls = HashSet::new();
        results.retain(|item| {
            if let Some(own) = own_ip_str.as_ref() {
                if &item.host == own && local_hits.contains(&(item.port, item.path.clone())) {
                    return false;
                }
            }
            seen_urls.insert(item.url.clone())
        });

        results.sort_by(|a, b| {
            (!a.is_local, &a.host, a.port, &a.path).cmp(&(!b.is_local, &b.host, b.port, &b.path))
        });

        results
    })
    .await
    .map_err(|err| format!("WebSocket discovery failed: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn validates_ws_upgrade_responses() {
        let valid = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: abc=\r\n\r\n";
        assert!(is_ws_upgrade_response(valid));

        let http_ok = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\nhello";
        assert!(!is_ws_upgrade_response(http_ok));

        let not_found = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
        assert!(!is_ws_upgrade_response(not_found));
    }

    #[test]
    fn builds_lan_subnet_hosts_only_for_private_ipv4() {
        let hosts = lan_subnet_hosts(Ipv4Addr::new(192, 168, 1, 42));
        assert_eq!(hosts.len(), 254);
        assert_eq!(hosts.first(), Some(&Ipv4Addr::new(192, 168, 1, 1)));
        assert_eq!(hosts.last(), Some(&Ipv4Addr::new(192, 168, 1, 254)));

        assert!(lan_subnet_hosts(Ipv4Addr::new(127, 0, 0, 1)).is_empty());
        assert!(lan_subnet_hosts(Ipv4Addr::new(8, 8, 8, 8)).is_empty());
    }

    fn spawn_mock_http_server(
        expected_connections: usize,
        responder: fn(&str) -> &'static str,
    ) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for _ in 0..expected_connections {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let mut buf = [0u8; 1024];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let resp = responder(&req);
                let _ = stream.write_all(resp.as_bytes());
            }
        });
        addr
    }

    #[test]
    fn probes_agent_luna_and_plain_http_endpoints() {
        let agent_addr = spawn_mock_http_server(1, |_| {
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: x\r\n\r\n"
        });
        let agent = probe_ws_endpoint(agent_addr, "127.0.0.1", true, Duration::from_millis(500)).unwrap();
        assert_eq!(agent.name, "Agent / Textractor");
        assert_eq!(agent.url, format!("ws://127.0.0.1:{}", agent_addr.port()));

        let luna_addr = spawn_mock_http_server(2, |req| {
            if req.starts_with("GET /api/text/origin ") {
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"
            } else {
                "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"
            }
        });
        let luna = probe_ws_endpoint(luna_addr, "192.168.1.50", false, Duration::from_millis(500)).unwrap();
        assert_eq!(luna.name, "LunaTranslator (192.168.1.50)");
        assert_eq!(
            luna.url,
            format!("ws://192.168.1.50:{}/api/text/origin", luna_addr.port())
        );

        let web_addr = spawn_mock_http_server(2, |_| {
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html></html>"
        });
        assert_eq!(
            probe_ws_endpoint(web_addr, "127.0.0.1", true, Duration::from_millis(500)),
            None
        );
    }
}
