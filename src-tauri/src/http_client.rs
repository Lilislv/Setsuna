//! HTTP clients for native requests (Google Drive, dictionary updates, audio).
//!
//! reqwest 0.13 verifies TLS through `rustls-platform-verifier`, which on
//! Android must be initialised from the JVM side; without that every HTTPS
//! request made from Rust fails. On Android we instead hand reqwest the
//! system's trusted root certificates directly, read from the CA store that
//! apps can access. Other platforms keep the default verifier.

/// A client builder that can make HTTPS requests on every platform.
pub fn builder() -> reqwest::ClientBuilder {
    let builder = reqwest::Client::builder();
    #[cfg(target_os = "android")]
    {
        let certs = android::root_certificates();
        if !certs.is_empty() {
            return builder.tls_certs_only(certs.iter().cloned());
        }
    }
    builder
}

/// A default client (see [`builder`]).
pub fn client() -> reqwest::Client {
    builder().build().unwrap_or_else(|_| reqwest::Client::new())
}

#[cfg(target_os = "android")]
mod android {
    use std::collections::HashSet;
    use std::sync::OnceLock;

    /// Android 14+ ships the CA store in the Conscrypt APEX; older releases
    /// keep it in /system. Both directories hold one PEM file per root.
    const CA_DIRS: [&str; 2] = ["/apex/com.android.conscrypt/cacerts", "/system/etc/security/cacerts"];

    pub fn root_certificates() -> &'static [reqwest::Certificate] {
        static CERTS: OnceLock<Vec<reqwest::Certificate>> = OnceLock::new();
        CERTS.get_or_init(|| {
            let mut seen = HashSet::new();
            let mut certs = Vec::new();
            for dir in CA_DIRS {
                let Ok(entries) = std::fs::read_dir(dir) else { continue };
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if !seen.insert(name) {
                        continue;
                    }
                    if let Ok(bytes) = std::fs::read(entry.path()) {
                        if let Ok(cert) = reqwest::Certificate::from_pem(&bytes) {
                            certs.push(cert);
                        }
                    }
                }
            }
            certs
        })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn builds_a_client() {
        let _ = super::client();
    }
}
