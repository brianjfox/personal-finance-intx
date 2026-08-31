// The Tauri v2 shell (BUILD_PLAN §7): a window, a menu with the kill
// switch, and the fin-host sidecar -- spawned on startup, killed on
// exit. The GUI is the same web app fin-host serves; the shell adds
// only what a browser cannot: the bundled binary, the Keychain-fed API
// key (macOS), and a double-clickable lifecycle.
//
// Startup sequence (§7.2): resolve the platform's data dir -> read the
// Anthropic key from the macOS Keychain (service "fin-interchange"; the
// GUI process never sees key material -- it goes straight into the
// child's environment; off macOS there is no keystore shell-out and the
// host falls back to its own environment) -> spawn `fin-host serve` on
// a free localhost port with the bundled GUI -> wait for /api/health ->
// open the window on the queue. The host resumes parked runs itself.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::process::Command as StdCommand;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

struct HostChild(Mutex<Option<CommandChild>>);

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(7797)
}

/// The same per-platform default the CLI's `defaultDataDir` resolves
/// (apps/host/src/cli.ts), so the app and `fin-host ...` commands share
/// one household: macOS `~/Library/Application Support/FinInterchange`,
/// Windows `%APPDATA%\CorbitsPersonalFinance` (falling back to the
/// conventional `AppData\Roaming` under the home dir when the env var
/// is unset), elsewhere `~/.fin-interchange`.
fn default_data_dir(home: PathBuf) -> PathBuf {
    if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("CorbitsPersonalFinance")
    } else if cfg!(target_os = "macos") {
        home.join("Library/Application Support/FinInterchange")
    } else {
        home.join(".fin-interchange")
    }
}

/// Read the Anthropic key from the login Keychain. Absent is fine: the
/// deterministic surfaces (ledger, tax, scenarios, exports) work without
/// it; only the advisory agents need it. Stored once with:
///   security add-generic-password -s fin-interchange -a anthropic -w <KEY>
#[cfg(target_os = "macos")]
fn keychain_api_key() -> Option<String> {
    let out = StdCommand::new("/usr/bin/security")
        .args(["find-generic-password", "-s", "fin-interchange", "-a", "anthropic", "-w"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let key = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if key.is_empty() {
        None
    } else {
        Some(key)
    }
}

/// Off macOS there is no Keychain and this shell claims none: the
/// sidecar inherits this process's environment, so a machine-level
/// ANTHROPIC_API_KEY still reaches the host without our help.
#[cfg(not(target_os = "macos"))]
fn keychain_api_key() -> Option<String> {
    None
}

fn wait_for_health(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) {
            use std::io::Write;
            let _ = s.set_read_timeout(Some(Duration::from_millis(1500)));
            let _ = s.write_all(format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").as_bytes());
            let mut buf = String::new();
            let _ = s.read_to_string(&mut buf);
            if buf.contains("200") && buf.contains("\"ok\":true") {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn kill_host(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<HostChild>() {
        if let Some(child) = state.0.lock().ok().and_then(|mut g| g.take()) {
            let _ = child.kill();
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let port = free_port();

            let data_dir = default_data_dir(app.path().home_dir().expect("no home directory"));
            std::fs::create_dir_all(&data_dir).ok();

            // The bundled GUI dist rides as a resource.
            let gui_dir = app
                .path()
                .resource_dir()
                .map(|r| r.join("gui"))
                .expect("no resource directory");

            let mut sidecar = app
                .shell()
                .sidecar("fin-host")
                .expect("fin-host sidecar missing from the bundle")
                .args([
                    "serve",
                    "--data",
                    data_dir.to_string_lossy().as_ref(),
                    "--gui",
                    gui_dir.to_string_lossy().as_ref(),
                    "--port",
                    &port.to_string(),
                ]);
            // Keychain -> child env; the shell process never logs or
            // persists it (BUILD_PLAN §7.3).
            if let Some(key) = keychain_api_key() {
                sidecar = sidecar.env("ANTHROPIC_API_KEY", key);
            }
            let (_rx, child) = sidecar.spawn().expect("failed to spawn fin-host");
            app.manage(HostChild(Mutex::new(Some(child))));

            // The kill switch, reachable from the menu bar.
            let kill = MenuItem::with_id(app, "kill-host", "Kill Switch: Stop fin-host", true, Some("CmdOrCtrl+Shift+K"))?;
            let menu = Menu::with_items(
                app,
                &[
                    &Submenu::with_items(
                        app,
                        "Corbits Personal Finance",
                        true,
                        &[&kill, &PredefinedMenuItem::separator(app)?, &PredefinedMenuItem::quit(app, None)?],
                    )?,
                    &Submenu::with_items(
                        app,
                        "Edit",
                        true,
                        &[
                            &PredefinedMenuItem::cut(app, None)?,
                            &PredefinedMenuItem::copy(app, None)?,
                            &PredefinedMenuItem::paste(app, None)?,
                            &PredefinedMenuItem::select_all(app, None)?,
                        ],
                    )?,
                ],
            )?;
            app.set_menu(menu)?;
            app.on_menu_event(move |app_handle, event| {
                if event.id() == "kill-host" {
                    kill_host(app_handle);
                    app_handle.exit(0);
                }
            });

            // Open the window once the host answers (the host resumes
            // parked runs before listening, so this also waits for that).
            std::thread::spawn(move || {
                let healthy = wait_for_health(port, Duration::from_secs(60));
                let url = format!("http://127.0.0.1:{port}/");
                let title = if healthy { "Corbits Personal Finance" } else { "Corbits Personal Finance (host not responding)" };
                let handle2 = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    let _ = WebviewWindowBuilder::new(&handle2, "main", WebviewUrl::External(url.parse().expect("bad url")))
                        .title(title)
                        .inner_size(1240.0, 860.0)
                        .build();
                });
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                kill_host(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build the app")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                kill_host(app);
            }
        });
}
