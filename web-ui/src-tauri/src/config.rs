use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct UserConfig {
    pub data_dir: Option<String>,
    #[serde(default)]
    pub minimize_to_tray: Option<bool>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

static CONFIG_WRITE_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn lock_config_write() -> std::sync::MutexGuard<'static, ()> {
    CONFIG_WRITE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("user-config.json"))
        .map_err(|e| format!("Failed to resolve app config dir: {e}"))
}

fn read_config(path: &Path) -> Result<UserConfig, String> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| {
            format!(
                "Invalid config {}: {e}. The original file has been preserved.",
                path.display()
            )
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(UserConfig::default()),
        Err(e) => Err(format!("Failed to read config {}: {e}", path.display())),
    }
}

pub(crate) fn load_user_config(app: &AppHandle) -> Result<UserConfig, String> {
    read_config(&config_path(app)?)
}

fn write_config(path: &Path, cfg: &UserConfig) -> Result<(), String> {
    let parent = path.parent().ok_or("Config path has no parent")?;
    fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {e}"))?;
    let text = serde_json::to_string_pretty(cfg)
        .map_err(|e| format!("Failed to serialize config: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    let mut file = fs::File::create(&tmp).map_err(|e| format!("Failed to write config: {e}"))?;
    file.write_all(text.as_bytes())
        .map_err(|e| format!("Failed to write config: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("Failed to flush config: {e}"))?;
    drop(file);
    fs::rename(&tmp, path).map_err(|e| format!("Failed to commit config: {e}"))
}

pub(crate) fn save_user_config(app: &AppHandle, cfg: &UserConfig) -> Result<(), String> {
    write_config(&config_path(app)?, cfg)
}

fn select_data_dir(
    env: Option<OsString>,
    configured: Option<&str>,
    default: PathBuf,
) -> Result<PathBuf, String> {
    let uses_saved_directory = env.is_none() && configured.is_some();
    let path = env
        .map(PathBuf::from)
        .or_else(|| configured.map(PathBuf::from))
        .unwrap_or(default);
    if !path.is_absolute() {
        return Err(format!(
            "Data directory must be an absolute path: {}",
            path.display()
        ));
    }
    if uses_saved_directory {
        let metadata = fs::metadata(&path).map_err(|error| {
            format!("Saved data directory is unavailable {}: {error}. Restore it or correct user-config.json; the saved path has not been changed.", path.display())
        })?;
        if !metadata.is_dir() {
            return Err(format!(
                "Saved data path is not a directory: {}",
                path.display()
            ));
        }
    }
    Ok(path)
}

pub(crate) fn resolve_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let cfg = load_user_config(app)?;
    #[cfg(target_os = "macos")]
    let default = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve macOS application data directory: {e}"))?
        .join("pc-data");
    #[cfg(not(target_os = "macos"))]
    let default = std::env::current_exe()
        .map_err(|e| format!("Failed to resolve executable: {e}"))?
        .parent()
        .ok_or("Executable has no parent directory")?
        .join("pc-data");
    select_data_dir(
        std::env::var_os("RIKKAHUB_PC_DATA_DIR"),
        cfg.data_dir.as_deref(),
        default,
    )
}

pub(crate) fn ensure_writable_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Data directory must be an absolute path".into());
    }
    fs::create_dir_all(path)
        .map_err(|e| format!("Failed to create data directory {}: {e}", path.display()))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let probe = path.join(format!(
        ".rikkahub-write-check-{}-{stamp}",
        std::process::id()
    ));
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|e| format!("Data directory is not writable {}: {e}", path.display()))?;
    drop(file);
    fs::remove_file(&probe)
        .map_err(|e| format!("Failed to remove write check {}: {e}", probe.display()))
}

/// Consume the installer's data-dir handoff file (NSIS_HOOK_POSTINSTALL writes the
/// chosen path as a plain-text single line). The installer must never write
/// user-config.json itself: rewriting a JSON it doesn't fully parse clobbers every
/// field it doesn't know about — that's exactly how `minimize_to_tray: false` kept
/// resurrecting to default-on after every update (专题6). We merge here via
/// load-modify-save (all other fields survive), then delete the handoff.
/// Must run before the first resolve_data_dir call so a fresh install's choice takes
/// effect on the very first launch.
/// B3(专题6复查):交接文件双格式解码。新版安装器用 FileWriteUTF16LE /BOM 写
/// (Unicode NSIS 的 FileWrite 按系统 ANSI 码页写,中文路径不是合法 UTF-8);
/// 无 BOM 则按 UTF-8 尝试(兼容旧版安装器的纯 ASCII 路径)。
fn decode_handoff_text(bytes: &[u8]) -> Option<String> {
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        return String::from_utf16(&units).ok();
    }
    String::from_utf8(bytes.to_vec()).ok()
}

pub(crate) fn consume_installer_data_dir_handoff(app: &AppHandle) {
    let Ok(config_dir) = app.path().app_config_dir() else {
        return;
    };
    let handoff = config_dir.join("installer-data-dir.txt");
    let Ok(bytes) = fs::read(&handoff) else {
        return;
    };
    let Some(text) = decode_handoff_text(&bytes) else {
        // B3:解不出来(旧版安装器 ANSI 写的非 ASCII 路径)必须删文件——重试永远
        // 同样失败,不删则每次启动都重试一遍且文件永久残留。记日志便于排查。
        eprintln!(
            "[rikkahub] installer handoff file is neither UTF-16LE(BOM) nor UTF-8; discarding"
        );
        let _ = fs::remove_file(&handoff);
        return;
    };
    let path = text.trim();
    if !path.is_empty() {
        let _guard = lock_config_write();
        let Ok(mut cfg) = load_user_config(app) else {
            return;
        };
        if cfg.data_dir.as_deref() != Some(path) {
            cfg.data_dir = Some(path.to_string());
            if save_user_config(app, &cfg).is_err() {
                // 合并失败(磁盘/权限):保留交接文件,下次启动重试。本次启动
                // resolve_data_dir 读到旧配置——与安装前行为一致,不丢数据。
                return;
            }
        }
    }
    let _ = fs::remove_file(&handoff);
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let sequence = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "rikkahub-config-{}-{stamp}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn data_precedence_preserves_explicit_paths_and_rejects_relative_paths() {
        let host = Fixture::new();
        let default = host.0.join("default");
        let saved = host.0.join("saved 中文");
        fs::create_dir(&saved).unwrap();
        let env = host.0.join("env with spaces");
        assert_eq!(
            select_data_dir(Some(env.clone().into()), saved.to_str(), default.clone()).unwrap(),
            env
        );
        assert_eq!(
            select_data_dir(None, saved.to_str(), default.clone()).unwrap(),
            saved
        );
        assert_eq!(
            select_data_dir(None, None, default.clone()).unwrap(),
            default
        );
        assert!(select_data_dir(Some("relative".into()), None, default.clone()).is_err());
        assert!(select_data_dir(Some("".into()), saved.to_str(), default).is_err());
    }

    #[test]
    fn malformed_config_is_never_replaced_or_moved() {
        let host = Fixture::new();
        let path = host.0.join("user-config.json");
        assert!(read_config(&path).unwrap().data_dir.is_none());
        fs::write(&path, "{broken").unwrap();
        assert!(read_config(&path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{broken");
        assert!(!path.with_extension("json.corrupted").exists());
    }

    #[test]
    fn missing_saved_directory_is_not_recreated_or_replaced_by_default() {
        let host = Fixture::new();
        let missing = host.0.join("moved data");
        let default = host.0.join("default");
        assert!(select_data_dir(None, missing.to_str(), default.clone()).is_err());
        assert!(!missing.exists());
        assert!(!default.exists());
    }

    #[test]
    fn config_roundtrip_preserves_unknown_fields() {
        let host = Fixture::new();
        let path = host.0.join("config/user-config.json");
        let cfg: UserConfig = serde_json::from_str(
            r#"{"data_dir":null,"minimize_to_tray":false,"future":{"enabled":true}}"#,
        )
        .unwrap();
        write_config(&path, &cfg).unwrap();
        let loaded = read_config(&path).unwrap();
        assert_eq!(loaded.minimize_to_tray, Some(false));
        assert_eq!(loaded.extra, cfg.extra);
    }

    #[test]
    fn writable_directory_probe_leaves_no_file_and_rejects_a_file() {
        let host = Fixture::new();
        let dir = host.0.join("new data");
        ensure_writable_directory(&dir).unwrap();
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        let file = host.0.join("file");
        fs::write(&file, "keep").unwrap();
        assert!(ensure_writable_directory(&file).is_err());
        assert_eq!(fs::read_to_string(file).unwrap(), "keep");
    }

    #[cfg(unix)]
    #[test]
    fn unwritable_directory_reports_failure_without_switching_paths() {
        use std::os::unix::fs::PermissionsExt;
        let host = Fixture::new();
        fs::set_permissions(&host.0, fs::Permissions::from_mode(0o500)).unwrap();
        let result = ensure_writable_directory(&host.0);
        fs::set_permissions(&host.0, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err());
        assert_eq!(fs::read_dir(&host.0).unwrap().count(), 0);
    }
}
