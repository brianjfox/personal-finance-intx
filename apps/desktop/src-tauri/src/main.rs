// The Tauri v2 shell (BUILD_PLAN §7): a window, a menu-bar (tray) icon
// that OWNS the app's life, a menu with the kill switch, and the
// fin-host sidecar -- spawned on startup, killed only on a real quit.
// Closing the window merely hides it (issue #67): the host keeps
// serving so the nightly imports actually run; Quit -- from the tray or
// the application menu (Cmd+Q) -- is what stops the host. The GUI is
// the same web app fin-host serves; the shell adds only what a browser
// cannot: the bundled binary, the Keychain-fed API key (macOS), and a
// double-clickable lifecycle.
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

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

struct HostChild(Mutex<Option<CommandChild>>);
/// The sidecar's port, for re-opening the window from the tray.
struct HostPort(u16);

/// Show the main window (created after the health check), or rebuild it
/// if it is somehow gone. Never touches the host.
fn open_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    if let Some(port) = app.try_state::<HostPort>().map(|p| p.0) {
        let url = format!("http://127.0.0.1:{port}/");
        let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().expect("bad url")))
            .title("Corbits Personal Finance")
            .inner_size(1240.0, 860.0)
            .disable_drag_drop_handler()
            .build();
    }
}

/// The static splash the window opens on (issue #67 follow-up): shown
/// instantly, it polls the host itself (a no-cors fetch resolves on any
/// HTTP answer and rejects on connection-refused) and replaces to the
/// app the moment the host is up -- however long the first boot takes.
fn splash_html(port: u16) -> String {
    let url = format!("http://127.0.0.1:{port}/");
    format!(
        r##"<!doctype html><html><head><meta charset="utf-8"><title>Corbits Personal Finance</title><style>
  :root {{ color-scheme: light dark; }}
  body {{ margin: 0; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px;
         font: 15px -apple-system, system-ui, sans-serif; background: #f6f5f2; color: #4b4237; }}
  @media (prefers-color-scheme: dark) {{ body {{ background: #201d1a; color: #cfc6ba; }} }}
  .spin {{ width: 22px; height: 22px; border: 3px solid #d9893d44; border-top-color: #d9893d; border-radius: 50%; animation: r 0.9s linear infinite; }}
  @keyframes r {{ to {{ transform: rotate(360deg); }} }}
  .name {{ font-size: 19px; font-weight: 600; letter-spacing: 0.2px; }}
  .note {{ opacity: 0.75; }}
</style></head><body>
<svg width="72" height="72" viewBox="106 96 330 330" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Corbits mark">
<defs><mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><rect width="512" height="512" fill="#fff"/><line x1="128" y1="388" x2="396" y2="238" stroke="#000" stroke-width="32" stroke-linecap="round"/><polygon points="427,220 406,255 386,221" fill="#000" stroke="#000" stroke-width="18" stroke-linejoin="round"/></mask></defs>
<g mask="url(#cut)" fill="#D9893D"><rect x="140" y="336" width="48" height="60" rx="8"/><rect x="204" y="312" width="48" height="84" rx="8"/><rect x="268" y="284" width="48" height="112" rx="8"/><rect x="332" y="248" width="48" height="148" rx="8"/></g>
<g fill="#D9893D" stroke="#D9893D"><line x1="128" y1="388" x2="396" y2="238" stroke-width="14" stroke-linecap="round"/><polygon points="427,220 406,255 386,221" stroke-width="4" stroke-linejoin="round"/></g>
</svg>
<div class="name">Corbits Personal Finance</div>
<div style="display:flex;align-items:center;gap:10px"><div class="spin"></div><div class="note">Starting the household host&hellip;</div></div>
<script>
  const url = {url:?};
  const probe = () => fetch(url + "api/health", {{ mode: "no-cors", cache: "no-store" }})
    .then(() => location.replace(url))
    .catch(() => setTimeout(probe, 600));
  probe();
</script>
</body></html>"##
    )
}

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
    let splash_port = std::sync::Arc::new(std::sync::atomic::AtomicU16::new(0));
    let splash_port_reader = splash_port.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .register_uri_scheme_protocol("splash", move |_ctx, _req| {
            let port = splash_port_reader.load(std::sync::atomic::Ordering::SeqCst);
            tauri::http::Response::builder()
                .header("content-type", "text/html; charset=utf-8")
                .body(splash_html(port).into_bytes())
                .expect("splash response")
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let port = free_port();
            splash_port.store(port, std::sync::atomic::Ordering::SeqCst);

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
            app.manage(HostPort(port));

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

            // The menu-bar icon owns the app's life (issue #67): the
            // window is just a view. Open re-shows it; Quit is the real
            // exit that stops the host.
            let open_item = MenuItem::with_id(app, "tray-open", "Open Corbits Personal Finance", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "tray-quit", "Quit Corbits Personal Finance", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&open_item, &PredefinedMenuItem::separator(app)?, &quit_item])?;
            TrayIconBuilder::with_id("fin-tray")
                // A menu-bar icon must be a TEMPLATE image (monochrome,
                // alpha-only) so macOS tints it for the bar; the bundle
                // icon carries its tile and looks wrong there.
                .icon(Image::from_bytes(include_bytes!("../icons/tray-template.png")).expect("bad tray icon"))
                .icon_as_template(true)
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .tooltip("Corbits Personal Finance — the host keeps running while this icon is here")
                .on_menu_event(|app_handle, event| match event.id().as_ref() {
                    "tray-open" => open_main(app_handle),
                    "tray-quit" => app_handle.exit(0),
                    _ => {}
                })
                .build(app)?;

            // The window opens IMMEDIATELY on a static splash -- a
            // double-click that shows nothing (or a blank page) reads as
            // a dead app. The splash polls the host itself and replaces
            // to the app the moment it answers; the health thread below
            // is the belt-and-braces fallback and fixes the title.
            let splash_url = if cfg!(windows) { "http://splash.localhost/" } else { "splash://localhost/" };
            let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(splash_url.parse().expect("bad url")))
                .title("Corbits Personal Finance — starting the host…")
                .inner_size(1240.0, 860.0)
                // Tauri's drag-drop handler intercepts native drags
                // for file-drop delivery, which prevents in-page
                // HTML5 drag-and-drop (the institution-card
                // reorder) from ever receiving the drop. Uploads
                // use a file input, so nothing needs the handler.
                .disable_drag_drop_handler()
                .build();
            std::thread::spawn(move || {
                let healthy = wait_for_health(port, Duration::from_secs(120));
                let title = if healthy { "Corbits Personal Finance" } else { "Corbits Personal Finance (host not responding)" };
                let handle2 = handle.clone();
                let nav_url = format!("http://127.0.0.1:{port}/");
                let _ = handle.run_on_main_thread(move || {
                    if let Some(w) = handle2.get_webview_window("main") {
                        let _ = w.set_title(title);
                        if healthy {
                            // The window's first load raced the host and
                            // failed to a BLANK page; location.reload()
                            // on about:blank is a no-op. Replace with the
                            // absolute URL instead -- that navigates from
                            // any context, blank included.
                            let _ = w.eval(&format!("window.location.replace('{nav_url}')"));
                        }
                    }
                });
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window must NOT stop the host (issue #67): the
            // nightly imports need it alive. Hide instead; the tray (and
            // the Dock on macOS) brings it back.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build the app")
        .run(|app, event| match event {
            // A no-windows-left exit request (never an explicit
            // app.exit/quit, which carries a code) is refused: the tray
            // owns the lifecycle.
            tauri::RunEvent::ExitRequested { code: None, api, .. } => {
                api.prevent_exit();
            }
            tauri::RunEvent::Exit => {
                kill_host(app);
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                open_main(app);
            }
            _ => {}
        });
}
