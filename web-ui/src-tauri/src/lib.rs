//! Rikkahub desktop shell: application setup and public IPC commands.
//! Window/menu behavior and owned backend lifecycle each have a single module.

use std::path::Path;
#[cfg(windows)]
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

mod config;
mod desktop;
#[cfg(target_os = "macos")]
mod environment;
#[cfg(target_os = "macos")]
mod fonts;
mod sidecar;
mod startup;
#[cfg(target_os = "macos")]
mod updates;

use config::{
    ensure_writable_directory, load_user_config, lock_config_write, resolve_data_dir,
    save_user_config,
};
use desktop::minimize_to_tray_enabled;

#[tauri::command]
fn get_data_dir(app: AppHandle) -> Result<String, String> {
    Ok(resolve_data_dir(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
fn set_data_dir(app: AppHandle, path: String) -> Result<(), String> {
    let trimmed = path.trim().to_string();
    let _guard = lock_config_write();
    let mut cfg = load_user_config(&app)?;
    cfg.data_dir = if trimmed.is_empty() {
        None
    } else {
        ensure_writable_directory(Path::new(&trimmed))?;
        Some(trimmed)
    };
    save_user_config(&app, &cfg)
}

#[tauri::command]
fn get_minimize_to_tray(app: AppHandle) -> Result<bool, String> {
    minimize_to_tray_enabled(&app)
}

#[tauri::command]
fn set_minimize_to_tray(app: AppHandle, enabled: bool) -> Result<(), String> {
    let _guard = lock_config_write();
    let mut cfg = load_user_config(&app)?;
    cfg.minimize_to_tray = Some(enabled);
    save_user_config(&app, &cfg)
}

/// Launches an installer .exe as a detached process so our shell exiting doesn't take it
/// down. Used by the in-app update flow: backend downloads to the data directory's cache,
/// frontend calls this to launch it, then the user is prompted to close Rikkahub so the
/// NSIS installer's "close target app" check doesn't block.
///
/// We don't attach the child to the kill-on-close job object (that's only for the sidecar)
/// and we drop the `Child` handle without `wait()` so the installer process is fully
/// independent. After this returns Ok, the caller should immediately exit the app.
#[tauri::command]
#[cfg(windows)]
fn launch_installer(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Installer path is empty".to_string());
    }
    let installer_path = PathBuf::from(trimmed);
    if !installer_path.exists() {
        return Err(format!("Installer not found: {}", installer_path.display()));
    }
    // Sanity: only allow .exe so we don't accidentally run scripts the backend handed us.
    let ext_ok = installer_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("exe"))
        .unwrap_or(false);
    if !ext_ok {
        return Err(format!(
            "Refusing to launch non-exe: {}",
            installer_path.display()
        ));
    }
    spawn_installer(&installer_path)
        .map(|_| ())
        .map_err(|e| format!("Failed to launch installer: {e}"))
}

/// 启动安装器为独立进程,脱离壳可能所在的 Job Object。
///
/// 壳(rikkahub.exe)自己不入它给 sidecar 建的 KILL_ON_JOB_CLOSE job,正常双击启动时安装器
/// 不会被连坐;但若壳被外部放进 job(从 IDE / 沙箱 / 进程监视器拉起),Windows 会自动把安装器
/// 加入同一 job,壳退出时 KILL_ON_JOB_CLOSE 会连坐杀掉安装器。CREATE_BREAKAWAY_FROM_JOB 让
/// 子进程脱离 job;若所处 job 不允许 breakaway,回退普通 spawn 保证安装器至少能启动。
///
/// 注意:这里只用 CreateProcess 不用 ShellExecute("runas")——当前 installMode=currentUser,
/// 安装器 manifest 是 asInvoker,CreateProcess 直接启动不弹 UAC;改 runas 会强制提升、每次
/// 更新都弹 UAC,是 UX 退化。将来 installMode 改 perMachine/both 再换 ShellExecuteW。
#[cfg(windows)]
fn spawn_installer(installer: &Path) -> std::io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    std::process::Command::new(installer)
        .creation_flags(CREATE_BREAKAWAY_FROM_JOB)
        .spawn()
        .or_else(|_| {
            std::process::Command::new(installer)
                .creation_flags(0)
                .spawn()
        })
}

#[cfg(not(windows))]
#[tauri::command]
fn launch_installer(path: String) -> Result<(), String> {
    let _ = path;
    Err("Windows installers can only be launched on Windows".into())
}

#[tauri::command]
async fn open_update_dmg(app: AppHandle, path: String, version: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let data_dir = resolve_data_dir(&app)?;
        tauri::async_runtime::spawn_blocking(move || {
            updates::open_downloaded_dmg(&data_dir, Path::new(&path), &version)
        })
        .await
        .map_err(|error| format!("Failed to verify update package: {error}"))?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, path, version);
        Err("DMG updates can only be opened on macOS".into())
    }
}

/// Headless platform helper, deliberately before Tauri/instance/data initialization.
#[cfg(target_os = "macos")]
pub fn print_system_fonts() -> Result<(), String> {
    let names = fonts::families()?;
    serde_json::to_writer(std::io::stdout().lock(), &names).map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            startup::log("Second launch received; restoring existing window");
            desktop::show_main_window(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::VISIBLE
                        & !tauri_plugin_window_state::StateFlags::DECORATIONS,
                )
                .build(),
        )
        .manage(sidecar::SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            get_data_dir,
            set_data_dir,
            launch_installer,
            open_update_dmg,
            get_minimize_to_tray,
            set_minimize_to_tray,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Err(error) = startup::initialize_log(&handle)
                .and_then(|_| desktop::initialize(&handle))
                .and_then(|_| load_user_config(&handle).map(|_| ()))
            {
                startup::show_error(&handle, "Rikkahub 启动失败", &error, true);
                return Ok(());
            }
            config::consume_installer_data_dir_handoff(&handle);
            match startup::desktop_dev_url() {
                Ok(Some(url)) => {
                    if let Err(error) =
                        resolve_data_dir(&handle).and_then(|dir| ensure_writable_directory(&dir))
                    {
                        startup::show_error(&handle, "Rikkahub 启动失败", &error, true);
                        return Ok(());
                    }
                    startup::log(&format!(
                        "Development backend owned by launcher; WebView: {url}"
                    ));
                    if let Some(window) = handle.get_webview_window("main") {
                        if let Err(error) = window.navigate(url) {
                            startup::show_error(
                                &handle,
                                "Rikkahub 启动失败",
                                &error.to_string(),
                                true,
                            );
                            return Ok(());
                        }
                    }
                    desktop::show_main_window(&handle);
                    let _ = handle.emit("sidecar://ready", true);
                }
                Ok(None) => {
                    desktop::show_main_window(&handle);
                    if let Err(error) = sidecar::start(&handle) {
                        startup::show_error(&handle, "Rikkahub 启动失败", &error, true);
                    }
                }
                Err(error) => startup::show_error(&handle, "Rikkahub 启动失败", &error, true),
            }
            Ok(())
        })
        .on_window_event(desktop::on_window_event)
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(sidecar::on_run_event);
}
