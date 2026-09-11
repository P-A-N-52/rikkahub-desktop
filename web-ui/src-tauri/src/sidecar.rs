use std::{
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU16, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, RunEvent};

use crate::{config, startup};

#[derive(Default)]
pub(crate) struct SidecarState {
    // All waiting/signalling shares this lock. A reaped PID is removed before it
    // can be reused; SIGTERM checks try_wait while retaining the Child lock.
    child: Mutex<Option<Child>>,
    exit_status: Mutex<Option<ExitStatus>>,
    shutdown: OnceLock<Result<(), String>>,
    port: AtomicU16,
    stopping: AtomicBool,
    exit_ready: AtomicBool,
    error_shown: AtomicBool,
}

fn show_failure(app: &AppHandle, message: &str) {
    let state = app.state::<SidecarState>();
    if !state.stopping.load(Ordering::Acquire) && !state.error_shown.swap(true, Ordering::AcqRel) {
        startup::show_error(app, "Rikkahub 后端已停止", message, true);
    }
}

fn failure_message(fatal: &Mutex<Option<String>>) -> String {
    fatal.lock().unwrap().clone().unwrap_or_else(|| {
        "后端进程意外退出。请退出并重新打开 Rikkahub；最近尚未保存的内容可能需要检查。".into()
    })
}

fn read_lines(
    reader: impl Read + Send + 'static,
    mut consume: impl FnMut(&str) + Send + 'static,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut bytes = Vec::new();
        loop {
            bytes.clear();
            match reader.read_until(b'\n', &mut bytes) {
                Ok(0) => return,
                Ok(_) => consume(String::from_utf8_lossy(&bytes).trim_end_matches(['\r', '\n'])),
                Err(error) => {
                    startup::log(&format!("Failed reading sidecar output: {error}"));
                    return;
                }
            }
        }
    })
}

fn finish_output(reader: thread::JoinHandle<()>, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while !reader.is_finished() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    reader.is_finished() && reader.join().is_ok()
}

pub(crate) fn start(app: &AppHandle) -> Result<(), String> {
    let data_dir = config::resolve_data_dir(app)?;
    config::ensure_writable_directory(&data_dir)?;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let binary: PathBuf = executable
        .parent()
        .ok_or("Executable has no parent directory")?
        .join(if cfg!(windows) {
            "rikkahub-server.exe"
        } else {
            "rikkahub-server"
        });
    let mut command = Command::new(&binary);
    command
        .arg("--no-open")
        .env("RIKKAHUB_PC_DATA_DIR", &data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW, as in the shell plugin.
    }
    #[cfg(target_os = "macos")]
    // Shared environment contract with upstream PR #39. The backend validates
    // its actual parent relationship; standalone servers have no watchdog.
    {
        command
            .env("RIKKAHUB_PARENT_PID", std::process::id().to_string())
            .env("RIKKAHUB_FONT_HELPER", &executable)
            .env("PATH", crate::environment::command_path()?);
    }
    if !cfg!(debug_assertions) {
        let resources = app
            .path()
            .resource_dir()
            .map_err(|error| error.to_string())?;
        startup::log(&format!("Resource directory: {}", resources.display()));
        command.env("RIKKAHUB_RESOURCE_DIR", resources);
    }
    startup::log(&format!("Data directory: {}", data_dir.display()));
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start {}: {error}", binary.display()))?;
    startup::log(&format!("Sidecar pid: {}", child.id()));
    #[cfg(windows)]
    bind_to_kill_on_close_job(child.id());
    let stdout = child.stdout.take().expect("piped sidecar stdout");
    let stderr = child.stderr.take().expect("piped sidecar stderr");
    *app.state::<SidecarState>().child.lock().unwrap() = Some(child);

    let fatal = Arc::new(Mutex::new(None));
    let (ready_tx, ready_rx) = mpsc::channel::<Result<u16, String>>();
    let output_app = app.clone();
    let output_tx = ready_tx.clone();
    let output_fatal = fatal.clone();
    let mut reported_port = false;
    let stdout_reader = read_lines(stdout, move |line| {
        eprintln!("[sidecar] {line}");
        if !reported_port {
            if let Some(port) = startup::parse_port_marker(line) {
                reported_port = true;
                if let Ok(port) = port.as_ref() {
                    output_app
                        .state::<SidecarState>()
                        .port
                        .store(*port, Ordering::Release);
                    startup::log(&format!("Sidecar ready on port {port}"));
                }
                let _ = output_tx.send(port);
            }
        }
        if let Some(rest) = line.strip_prefix("RIKKAHUB_FATAL:") {
            let message = rest
                .split_once(':')
                .map(|(_, message)| message)
                .unwrap_or(rest)
                .trim();
            if !message.is_empty() {
                startup::log(message);
                *output_fatal.lock().unwrap() = Some(message.to_string());
            }
        }
    });
    let error_app = app.clone();
    read_lines(stderr, move |line| {
        if error_app
            .state::<SidecarState>()
            .port
            .load(Ordering::Acquire)
            == 0
        {
            startup::log(line);
        } else {
            eprintln!("[sidecar:err] {line}");
        }
    });

    let monitor_app = app.clone();
    thread::spawn(move || loop {
        let state = monitor_app.state::<SidecarState>();
        let result = {
            let mut guard = state.child.lock().unwrap();
            let Some(child) = guard.as_mut() else {
                return;
            };
            match child.try_wait() {
                Ok(Some(status)) => {
                    *state.exit_status.lock().unwrap() = Some(status);
                    guard.take();
                    Some(Ok(status))
                }
                Ok(None) => None,
                Err(error) => Some(Err(error)),
            }
        };
        if let Some(result) = result {
            match result {
                Ok(status) => startup::log(&format!("Sidecar exited: {status}")),
                Err(error) => startup::log(&format!("Failed to wait for sidecar: {error}")),
            }
            // A fast exit can be observed before its final error marker is read.
            // Do not wait indefinitely if a descendant retained the output pipe.
            if !state.stopping.load(Ordering::Acquire)
                && !finish_output(stdout_reader, Duration::from_millis(500))
            {
                startup::log("Sidecar output did not finish within the diagnostic deadline");
            }
            let message = failure_message(&fatal);
            let _ = ready_tx.send(Err(message.clone()));
            if state.port.load(Ordering::Acquire) != 0 {
                show_failure(&monitor_app, &message);
            }
            return;
        }
        thread::sleep(Duration::from_millis(50));
    });

    let ready_app = app.clone();
    thread::spawn(move || {
        let result = ready_rx
            .recv_timeout(Duration::from_secs(60))
            .unwrap_or_else(|error| {
                Err(format!("后端未能报告监听端口：{error}。请查看启动日志。"))
            });
        match result {
            Ok(port) => {
                let state = ready_app.state::<SidecarState>();
                if state.stopping.load(Ordering::Acquire)
                    || state.error_shown.load(Ordering::Acquire)
                {
                    return;
                }
                if let Some(window) = ready_app.get_webview_window("main") {
                    let url = format!("http://localhost:{port}")
                        .parse()
                        .expect("valid loopback URL");
                    if let Err(error) = window.navigate(url) {
                        show_failure(&ready_app, &format!("无法打开后端页面：{error}"));
                    }
                }
                let _ = ready_app.emit("sidecar://ready", true);
            }
            Err(message) => show_failure(&ready_app, &message),
        }
    });
    Ok(())
}

fn request_shutdown(port: u16, timeout: Duration) -> Result<(), String> {
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = std::net::TcpStream::connect_timeout(&address, Duration::from_millis(500))
        .map_err(|error| format!("Shutdown connection: {error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_millis(500)))
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    let request = format!("POST /api/app/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;
    let mut status = String::new();
    BufReader::new(stream)
        .take(512)
        .read_line(&mut status)
        .map_err(|error| error.to_string())?;
    let mut parts = status.split_whitespace();
    if matches!(parts.next(), Some("HTTP/1.0" | "HTTP/1.1")) && parts.next() == Some("200") {
        startup::log("Backend confirmed shutdown completed");
        Ok(())
    } else {
        Err(format!(
            "Backend did not confirm clean shutdown: {}",
            status.trim()
        ))
    }
}

fn wait_for_exit(state: &SidecarState, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if state.child.lock().unwrap().is_none() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(target_os = "macos")]
fn request_termination(state: &SidecarState) -> Result<(), String> {
    let mut guard = state.child.lock().unwrap();
    let Some(child) = guard.as_mut() else {
        return Ok(());
    };
    if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
        *state.exit_status.lock().unwrap() = Some(status);
        guard.take();
        return Ok(());
    }
    let pid = i32::try_from(child.id()).map_err(|error| error.to_string())?;
    // The Child lock prevents the monitor from reaping/reusing this PID between
    // try_wait and kill. Only the direct child can be signalled here.
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
        return Err(format!(
            "SIGTERM to sidecar {pid}: {}",
            std::io::Error::last_os_error()
        ));
    }
    startup::log(&format!("Requested SIGTERM for sidecar {pid}"));
    Ok(())
}

fn exit_result(state: &SidecarState) -> Result<(), String> {
    match *state.exit_status.lock().unwrap() {
        Some(status) if !status.success() => {
            Err(format!("Backend exited without clean completion: {status}"))
        }
        _ => Ok(()),
    }
}

fn stop(app: &AppHandle) -> Result<(), String> {
    app.state::<SidecarState>()
        .shutdown
        .get_or_init(|| stop_owned_child(app))
        .clone()
}

fn stop_owned_child(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<SidecarState>();
    if state.child.lock().unwrap().is_none() {
        return exit_result(&state);
    }
    let port = state.port.load(Ordering::Acquire);
    if port != 0 {
        if let Err(error) = request_shutdown(port, Duration::from_secs(10)) {
            startup::log(&error);
        }
        if wait_for_exit(&state, Duration::from_secs(1)) {
            return exit_result(&state);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Err(error) = request_termination(&state) {
            startup::log(&error);
        }
        if wait_for_exit(&state, Duration::from_secs(3)) {
            return exit_result(&state);
        }
    }
    {
        let mut guard = state.child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            startup::log(&format!(
                "Sidecar {} exceeded shutdown deadline; terminating owned child",
                child.id()
            ));
            if let Err(error) = child.kill() {
                startup::log(&format!("Failed to terminate sidecar: {error}"));
            }
        }
    }
    if !wait_for_exit(&state, Duration::from_secs(1)) {
        return Err("Sidecar termination was not confirmed before application exit".into());
    }
    exit_result(&state)
}

pub(crate) fn on_run_event(app: &AppHandle, event: RunEvent) {
    match event {
        RunEvent::ExitRequested { api, code, .. } => {
            let state = app.state::<SidecarState>();
            if state.exit_ready.load(Ordering::Acquire) {
                return;
            }
            // Tauri does not allow preventing its special restart exit request.
            // Complete the same shutdown here before the runtime starts a new app.
            if code == Some(tauri::RESTART_EXIT_CODE) {
                state.stopping.store(true, Ordering::Release);
                if let Err(error) = stop(app) {
                    startup::log(&error);
                }
                state.exit_ready.store(true, Ordering::Release);
                return;
            }
            api.prevent_exit();
            if !state.stopping.swap(true, Ordering::AcqRel) {
                startup::log("Application exit requested; waiting for backend shutdown");
                let app = app.clone();
                thread::spawn(move || {
                    let result = stop(&app);
                    let mut exit_code = code.unwrap_or(0);
                    if let Err(error) = result {
                        startup::log(&error);
                        if exit_code == 0 {
                            exit_code = 1;
                        }
                    }
                    app.state::<SidecarState>()
                        .exit_ready
                        .store(true, Ordering::Release);
                    startup::log("Application shutdown finished");
                    app.exit(exit_code);
                });
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if !app.state::<SidecarState>().stopping.load(Ordering::Acquire) {
                startup::log("Application reopened; restoring main window");
                crate::desktop::show_main_window(app);
            }
        }
        RunEvent::Exit => {
            // Runtime exits without ExitRequested (for example an OS termination)
            // still get bounded cleanup. Our Child is not owned by a plugin that
            // kills it before this callback runs.
            if !app
                .state::<SidecarState>()
                .exit_ready
                .load(Ordering::Acquire)
            {
                app.state::<SidecarState>()
                    .stopping
                    .store(true, Ordering::Release);
                if let Err(error) = stop(app) {
                    startup::log(&error);
                }
            }
        }
        _ => {}
    }
}

#[cfg(windows)]
fn bind_to_kill_on_close_job(child_pid: u32) {
    use std::mem::size_of;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_BASIC_LIMIT_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_ALL_ACCESS};

    static JOB_HANDLE: std::sync::OnceLock<usize> = std::sync::OnceLock::new();

    unsafe {
        // Lazily create the singleton job — first sidecar spawn establishes it; later spawns
        // (e.g. after a data-dir change + restart) attach to the same job.
        let job_raw = *JOB_HANDLE.get_or_init(|| {
            let job = CreateJobObjectW(None, windows::core::PCWSTR::null()).unwrap_or_default();
            if job.is_invalid() {
                return 0;
            }
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
                BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION {
                    LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                    ..Default::default()
                },
                ..Default::default()
            };
            let _ = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            let _ = &mut info; // keep alive past the call
            job.0 as usize
        });
        if job_raw == 0 {
            return;
        }
        let job = HANDLE(job_raw as *mut _);
        let proc = match OpenProcess(PROCESS_ALL_ACCESS, false, child_pid) {
            Ok(h) => h,
            Err(err) => {
                eprintln!("[sidecar:job] OpenProcess failed: {err:?}");
                return;
            }
        };
        if AssignProcessToJobObject(job, proc).is_err() {
            eprintln!("[sidecar:job] AssignProcessToJobObject failed (already in a job?)");
        }
        // We intentionally close only the per-call process handle, not the job handle —
        // the job must outlive this function so the OS keeps the kill-on-close semantics.
        let _ = CloseHandle(proc);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn final_output_is_drained_after_the_process_has_exited() {
        let captured = Arc::new(Mutex::new(String::new()));
        let sink = captured.clone();
        let reader = read_lines(
            std::io::Cursor::new(b"RIKKAHUB_FATAL:TEST:specific cause\n"),
            move |line| {
                thread::sleep(Duration::from_millis(30));
                *sink.lock().unwrap() = line.into();
            },
        );
        assert!(finish_output(reader, Duration::from_secs(1)));
        assert!(captured.lock().unwrap().contains("specific cause"));
    }

    fn response_server(response: &'static [u8]) -> (u16, thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let worker = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                request.extend_from_slice(line.as_bytes());
                if line == "\r\n" {
                    break;
                }
            }
            assert!(request.starts_with(b"POST /api/app/shutdown HTTP/1.1\r\n"));
            socket.write_all(&response[..9]).unwrap();
            thread::sleep(Duration::from_millis(10));
            socket.write_all(&response[9..]).unwrap();
        });
        (port, worker)
    }

    #[test]
    fn shutdown_waits_for_a_complete_fragmented_http_status() {
        let (port, worker) = response_server(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
        assert!(request_shutdown(port, Duration::from_secs(1)).is_ok());
        worker.join().unwrap();
    }

    #[test]
    fn failed_flush_is_not_accepted_as_clean_shutdown() {
        let (port, worker) = response_server(b"HTTP/1.1 500 Failed\r\nContent-Length: 0\r\n\r\n");
        assert!(request_shutdown(port, Duration::from_secs(1))
            .unwrap_err()
            .contains("500"));
        worker.join().unwrap();
    }
}
