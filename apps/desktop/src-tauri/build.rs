fn main() {
    tauri_build::build();
    // The Tauri app gets this through its resources, but Rust's standalone test
    // harness also links dialogs that require Common Controls v6.
    println!("cargo:rerun-if-env-changed=EASYDOC_TEST_MANIFEST");
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
        && std::env::var("EASYDOC_TEST_MANIFEST").as_deref() == Ok("1")
    {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("windows.manifest");
        println!("cargo:rerun-if-changed=windows.manifest");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
}
