use std::{fs, io::Write, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Manager, Url};

static LOG: Mutex<Option<fs::File>> = Mutex::new(None);

pub(crate) fn log_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_log_dir()
        .map(|dir| dir.join("shell.log"))
        .map_err(|e| e.to_string())
}

pub(crate) fn initialize_log(app: &AppHandle) -> Result<(), String> {
    let path = log_path(app)?;
    fs::create_dir_all(path.parent().ok_or("Shell log has no parent directory")?)
        .map_err(|e| format!("Failed to create shell log directory: {e}"))?;
    let file = fs::File::create(&path)
        .map_err(|e| format!("Failed to open shell log {}: {e}", path.display()))?;
    *LOG.lock().map_err(|e| e.to_string())? = Some(file);
    log("Starting Rikkahub desktop shell");
    Ok(())
}

pub(crate) fn log(message: &str) {
    eprintln!("[startup] {message}");
    if let Ok(mut guard) = LOG.lock() {
        if let Some(file) = guard.as_mut() {
            if let Err(error) = writeln!(file, "{message}") {
                eprintln!("[startup] Failed to write shell log: {error}");
            }
        }
    }
}

pub(crate) fn parse_port_marker(line: &str) -> Option<Result<u16, String>> {
    line.strip_prefix("RIKKAHUB_PORT:").map(|port| {
        port.trim()
            .parse::<u16>()
            .ok()
            .filter(|value| *value != 0)
            .ok_or_else(|| format!("Invalid sidecar port marker: {line}"))
    })
}

fn parse_dev_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|e| format!("Invalid desktop dev URL: {e}"))?;
    // Url normalizes an explicit :80 to no port; inspect the supplied authority so
    // the launcher's valid port 80 is accepted while a missing/zero port is rejected.
    let explicit_port = value
        .strip_prefix("http://")
        .and_then(|rest| rest.split(['/', '?', '#']).next())
        .and_then(|authority| authority.rsplit_once(':'))
        .and_then(|(_, port)| port.parse::<u16>().ok())
        .filter(|port| *port != 0);
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        || explicit_port.is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Desktop dev URL must be an HTTP loopback URL with an explicit port".into());
    }
    Ok(url)
}

pub(crate) fn desktop_dev_url() -> Result<Option<Url>, String> {
    if cfg!(debug_assertions) {
        return std::env::var("RIKKAHUB_DESKTOP_DEV_URL")
            .ok()
            .map(|value| parse_dev_url(&value))
            .transpose();
    }
    Ok(None)
}

/// Keep errors attached to the application window, with a responsive event loop.
pub(crate) fn show_error(app: &AppHandle, title: &str, message: &str, exit_after: bool) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    log(message);
    crate::desktop::show_main_window(app);
    let details = match log_path(app) {
        Ok(path) => format!("{message}\n\n诊断日志：{}", path.display()),
        Err(_) => message.to_string(),
    };
    let mut dialog = app
        .dialog()
        .message(details)
        .kind(MessageDialogKind::Error)
        .title(title);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.parent(&window);
    }
    if exit_after {
        dialog = dialog.buttons(MessageDialogButtons::OkCustom("退出".into()));
    }
    let handle = app.clone();
    dialog.show(move |_| {
        if exit_after {
            handle.exit(1);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_valid_port_markers() {
        assert!(parse_port_marker("startup log").is_none());
        assert_eq!(
            parse_port_marker("RIKKAHUB_PORT:8081").unwrap().unwrap(),
            8081
        );
        for line in [
            "RIKKAHUB_PORT:0",
            "RIKKAHUB_PORT:65536",
            "RIKKAHUB_PORT:not-a-port",
        ] {
            assert!(parse_port_marker(line).unwrap().is_err());
        }
    }

    #[test]
    fn dev_navigation_is_limited_to_explicit_loopback_ports() {
        assert!(parse_dev_url("http://127.0.0.1:5173").is_ok());
        assert!(parse_dev_url("http://127.0.0.1:80").is_ok());
        for url in [
            "http://example.com:5173",
            "file:///tmp/index.html",
            "http://localhost",
            "http://localhost:0",
            "http://user:pass@localhost:5173",
        ] {
            assert!(parse_dev_url(url).is_err());
        }
    }
}
