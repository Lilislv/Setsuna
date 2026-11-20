fn main() {
    // Android 15+ devices can run with 16 KB memory pages. Link the native
    // library with 16 KB segment alignment so it loads without the system
    // compatibility warning. (Tauri sets its own RUSTFLAGS for Android builds,
    // which would override a .cargo/config.toml entry.)
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
        println!("cargo:rustc-link-arg=-Wl,-z,common-page-size=16384");
    }
    tauri_build::build()
}
