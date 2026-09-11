// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "macos")]
    if std::env::args().nth(1).as_deref() == Some("--list-system-fonts") {
        if let Err(error) = rikkahub_lib::print_system_fonts() {
            eprintln!("System font query failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    rikkahub_lib::run()
}
