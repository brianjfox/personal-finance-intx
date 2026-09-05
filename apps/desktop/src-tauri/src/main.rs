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
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;

struct HostChild(Mutex<Option<CommandChild>>);
/// The sidecar's port, for re-opening the window from the tray.
struct HostPort(u16);
/// The two Refresh Assets items (File menu, tray), enabled only while
/// someone is signed in (D-048); the poll below flips them together.
struct RefreshItems(Mutex<Vec<MenuItem<tauri::Wry>>>);
/// Extra windows from File > New Window get unique labels.
static EXTRA_WINDOWS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Is anyone signed in? (`/api/tray/session`; a single-user host says yes.)
fn tray_signed_in(port: u16) -> bool {
    tray_http(port, "GET", "/api/tray/session").map(|b| b.contains("\"signed_in\":true")).unwrap_or(false)
}

/// File > New Window (D-048): one more window on the same host, opened
/// signed OUT (`?fresh=1` -- the page keeps that window's session in
/// memory only), so a second person can sign in beside the first.
fn open_extra_window(app: &tauri::AppHandle) {
    let Some(port) = app.try_state::<HostPort>().map(|p| p.0) else { return };
    let n = EXTRA_WINDOWS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let url = format!("http://127.0.0.1:{port}/?fresh=1");
    let _ = WebviewWindowBuilder::new(app, format!("extra-{n}"), WebviewUrl::External(url.parse().expect("bad url")))
        .title(APP_NAME)
        .inner_size(1240.0, 860.0)
        .disable_drag_drop_handler()
        .build();
}

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

const APP_NAME: &str = "Corbits Personal Finance";
const REPO_URL: &str = "https://github.com/brianjfox/personal-finance-intx";

/// A menu item the page handles: bring the window up, then hand the
/// action to the GUI as a `fin:menu` DOM event. The page is served by
/// the host over localhost, so this eval is the shell's one channel in.
fn menu_dispatch(app: &tauri::AppHandle, action: &str) {
    open_main(app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(&format!("window.dispatchEvent(new CustomEvent('fin:menu', {{ detail: '{action}' }}))"));
    }
}

/// "Check for Updates…" (D-047): ask the release feed for a newer
/// signed build and show one native dialog with the answer -- Update /
/// Later when there is one, "you have the newest version" when there is
/// not, the reason when the check could not be made. Update downloads
/// the signed artifact, verifies it against the public key in
/// tauri.conf.json, installs it over this bundle, and relaunches; the
/// host is stopped by the normal Exit path on the way out.
fn check_for_updates(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let current = env!("CARGO_PKG_VERSION");
        let updater = match app.updater() {
            Ok(u) => u,
            Err(e) => {
                app.dialog()
                    .message(format!("The updater could not start: {e}"))
                    .title("Software Update")
                    .kind(MessageDialogKind::Error)
                    .blocking_show();
                return;
            }
        };
        match updater.check().await {
            Ok(Some(update)) => {
                let go = app
                    .dialog()
                    .message(format!(
                        "Version {} is available. You have {current}.

Update downloads the signed build from GitHub, installs it over this copy, and relaunches the app.",
                        update.version
                    ))
                    .title("Software Update")
                    .kind(MessageDialogKind::Info)
                    .buttons(MessageDialogButtons::OkCancelCustom("Update".into(), "Later".into()))
                    .blocking_show();
                if !go {
                    return;
                }
                match update.download_and_install(|_chunk, _total| {}, || {}).await {
                    Ok(()) => {
                        app.dialog()
                            .message(format!("Version {} is installed. The app will now relaunch.", update.version))
                            .title("Software Update")
                            .kind(MessageDialogKind::Info)
                            .blocking_show();
                        kill_host(&app);
                        app.restart();
                    }
                    Err(e) => {
                        app.dialog()
                            .message(format!("The update could not be installed: {e}

Nothing was changed. You can download it from the release page instead."))
                            .title("Software Update")
                            .kind(MessageDialogKind::Error)
                            .blocking_show();
                    }
                }
            }
            Ok(None) => {
                app.dialog()
                    .message(format!("You have the newest version. Version {current} is the latest published release."))
                    .title("Software Update")
                    .kind(MessageDialogKind::Info)
                    .blocking_show();
            }
            Err(e) => {
                app.dialog()
                    .message(format!("Couldn't check for updates: {e}

Try again later, or look at the releases page yourself."))
                    .title("Software Update")
                    .kind(MessageDialogKind::Warning)
                    .blocking_show();
            }
        }
    });
}

/// The standard menu bar (D-046): the app menu, File, Edit, View,
/// Window and Help, with the platform's predefined items where they
/// exist and the app's own entries routed to the page. On macOS the
/// Window and Help submenus are registered with NSApp so the window
/// list and Help search appear.
fn build_menu(app: &tauri::App) -> tauri::Result<Menu<tauri::Wry>> {
    // About opens the page's own dialog (the one the brand click shows),
    // not the native panel: macOS renders only name/version/copyright/
    // credits there, and the operator wants the in-app one.
    let about = MenuItem::with_id(app, "menu-about", &format!("About {APP_NAME}"), true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "menu-settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let updates = MenuItem::with_id(app, "menu-updates", "Check for Updates…", true, None::<&str>)?;
    // The kill switch, reachable from the menu bar.
    let kill = MenuItem::with_id(app, "kill-host", "Kill Switch: Stop fin-host", true, Some("CmdOrCtrl+Shift+K"))?;
    let app_menu = Submenu::with_items(
        app,
        APP_NAME,
        true,
        &[&about, &PredefinedMenuItem::separator(app)?, &settings, &updates, &PredefinedMenuItem::separator(app)?, &kill],
    )?;
    #[cfg(target_os = "macos")]
    app_menu.append_items(&[
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::services(app, None)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::hide(app, None)?,
        &PredefinedMenuItem::hide_others(app, None)?,
        &PredefinedMenuItem::show_all(app, None)?,
    ])?;
    app_menu.append_items(&[&PredefinedMenuItem::separator(app)?, &PredefinedMenuItem::quit(app, None)?])?;

    let new_window = MenuItem::with_id(app, "menu-new-window", "New Window", true, Some("CmdOrCtrl+N"))?;
    // Disabled until the session poll finds someone signed in (D-048).
    let refresh = MenuItem::with_id(app, "menu-refresh", "Refresh Assets", false, Some("CmdOrCtrl+R"))?;
    let print = MenuItem::with_id(app, "menu-print", "Print…", true, Some("CmdOrCtrl+P"))?;
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_window,
            &PredefinedMenuItem::close_window(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &refresh,
            &PredefinedMenuItem::separator(app)?,
            &print,
        ],
    )?;
    app.manage(RefreshItems(Mutex::new(vec![refresh])));

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::bring_all_to_front(app, None)?,
        ],
    )?;
    #[cfg(target_os = "macos")]
    window_menu.set_as_windows_menu_for_nsapp()?;

    let help = MenuItem::with_id(app, "menu-help", &format!("{APP_NAME} Help"), true, None::<&str>)?;
    let notes = MenuItem::with_id(app, "menu-releases", "Release Notes", true, None::<&str>)?;
    let issue = MenuItem::with_id(app, "menu-issue", "Report an Issue…", true, None::<&str>)?;
    let help_menu = Submenu::with_items(app, "Help", true, &[&help, &PredefinedMenuItem::separator(app)?, &notes, &issue])?;
    #[cfg(target_os = "macos")]
    help_menu.set_as_help_menu_for_nsapp()?;

    Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
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

/// One tiny loopback HTTP exchange with the sidecar (no client crate):
/// returns the response body on a 200, None otherwise.
fn tray_http(port: u16, method: &str, path: &str) -> Option<String> {
    use std::io::Write;
    let mut s = TcpStream::connect(("127.0.0.1", port)).ok()?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    s.write_all(format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes())
        .ok()?;
    let mut buf = String::new();
    s.read_to_string(&mut buf).ok()?;
    if !buf.starts_with("HTTP/1.1 200") {
        return None;
    }
    buf.split("\r\n\r\n").nth(1).map(|b| b.to_string())
}

/// "15390927.0124" -> "15,390,927" (dollars, separators, no cents).
fn pretty_amount(raw: &str) -> String {
    let whole = raw.split('.').next().unwrap_or(raw);
    let (neg, digits) = whole.strip_prefix('-').map_or((false, whole), |d| (true, d));
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if neg {
        format!("-{out}")
    } else {
        out
    }
}

/// The tray's net-worth title, fetched from the loopback tray endpoint;
/// None when nobody is signed in (or the host is not up yet).
fn tray_networth_title(port: u16) -> Option<String> {
    let body = tray_http(port, "GET", "/api/tray/summary")?;
    if !body.contains("\"available\":true") {
        return None;
    }
    let nw = body.split("\"net_worth\":\"").nth(1)?.split('"').next()?;
    let currency = body.split("\"currency\":\"").nth(1).and_then(|c| c.split('"').next()).unwrap_or("USD");
    Some(if currency == "USD" { format!("${}", pretty_amount(nw)) } else { format!("{} {}", pretty_amount(nw), currency) })
}

/// The shell's own tiny setting (issue #72): whether the menu bar shows
/// the net worth. Lives beside the household data, no serde needed.
fn tray_config_path(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("tray.json")
}
fn read_show_net_worth(data_dir: &std::path::Path) -> bool {
    std::fs::read_to_string(tray_config_path(data_dir)).map(|s| s.contains("\"show_net_worth\":true")).unwrap_or(false)
}
fn write_show_net_worth(data_dir: &std::path::Path, on: bool) {
    let _ = std::fs::write(tray_config_path(data_dir), format!("{{\"show_net_worth\":{on}}}"));
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
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

            let menu = build_menu(app)?;
            app.set_menu(menu)?;
            app.on_menu_event(move |app_handle, event| match event.id().as_ref() {
                "kill-host" => {
                    kill_host(app_handle);
                    app_handle.exit(0);
                }
                "menu-about" => menu_dispatch(app_handle, "about"),
                "menu-settings" => menu_dispatch(app_handle, "settings"),
                "menu-updates" => check_for_updates(app_handle.clone()),
                "menu-new-window" => open_extra_window(app_handle),
                "menu-refresh" => {
                    if let Some(port) = app_handle.try_state::<HostPort>().map(|p| p.0) {
                        std::thread::spawn(move || {
                            let _ = tray_http(port, "POST", "/api/tray/refresh");
                        });
                    }
                }
                "menu-print" => menu_dispatch(app_handle, "print"),
                "menu-help" => menu_dispatch(app_handle, "help"),
                // The shell plugin's open() is deprecated in favour of a
                // separate opener plugin; it still hands a URL to the
                // default browser, and one more plugin is not worth it here.
                #[allow(deprecated)]
                "menu-releases" => {
                    let _ = app_handle.shell().open(format!("{REPO_URL}/releases"), None);
                }
                #[allow(deprecated)]
                "menu-issue" => {
                    let _ = app_handle.shell().open(format!("{REPO_URL}/issues/new"), None);
                }
                _ => {}
            });

            // The menu-bar icon owns the app's life (issue #67): the
            // window is just a view. Open re-shows it; Quit is the real
            // exit that stops the host.
            let open_item = MenuItem::with_id(app, "tray-open", "Open Corbits Personal Finance", true, None::<&str>)?;
            let refresh_item = MenuItem::with_id(app, "tray-refresh", "Refresh Assets", false, None::<&str>)?;
            if let Some(items) = app.try_state::<RefreshItems>() {
                items.0.lock().expect("refresh items").push(refresh_item.clone());
            }
            let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
            let autostart_item = CheckMenuItem::with_id(app, "tray-autostart", "Launch at Login", true, autostart_on, None::<&str>)?;
            let show_nw = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(read_show_net_worth(&data_dir)));
            let shownw_item = CheckMenuItem::with_id(app, "tray-shownw", "Show Net Worth", true, show_nw.load(std::sync::atomic::Ordering::SeqCst), None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "tray-quit", "Quit Corbits Personal Finance", true, None::<&str>)?;
            let tray_menu = Menu::with_items(
                app,
                &[
                    &open_item,
                    &refresh_item,
                    &PredefinedMenuItem::separator(app)?,
                    &autostart_item,
                    &shownw_item,
                    &PredefinedMenuItem::separator(app)?,
                    &quit_item,
                ],
            )?;
            TrayIconBuilder::with_id("fin-tray")
                // A menu-bar icon must be a TEMPLATE image (monochrome,
                // alpha-only) so macOS tints it for the bar; the bundle
                // icon carries its tile and looks wrong there.
                .icon(Image::from_bytes(include_bytes!("../icons/tray-template.png")).expect("bad tray icon"))
                .icon_as_template(true)
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .tooltip("Corbits Personal Finance — the host keeps running while this icon is here")
                .on_menu_event({
                    let autostart_item = autostart_item.clone();
                    let shownw_item = shownw_item.clone();
                    let show_nw = show_nw.clone();
                    let data_dir = data_dir.clone();
                    move |app_handle, event| match event.id().as_ref() {
                        "tray-open" => open_main(app_handle),
                        "tray-refresh" => {
                            std::thread::spawn(move || {
                                let _ = tray_http(port, "POST", "/api/tray/refresh");
                            });
                        }
                        "tray-autostart" => {
                            let auto = app_handle.autolaunch();
                            if auto.is_enabled().unwrap_or(false) {
                                let _ = auto.disable();
                            } else {
                                let _ = auto.enable();
                            }
                            let _ = autostart_item.set_checked(auto.is_enabled().unwrap_or(false));
                        }
                        "tray-shownw" => {
                            let on = !show_nw.load(std::sync::atomic::Ordering::SeqCst);
                            show_nw.store(on, std::sync::atomic::Ordering::SeqCst);
                            write_show_net_worth(&data_dir, on);
                            let _ = shownw_item.set_checked(on);
                            let title = if on { tray_networth_title(port) } else { None };
                            if let Some(tray) = app_handle.tray_by_id("fin-tray") {
                                let _ = tray.set_title(title.as_deref());
                            }
                        }
                        "tray-quit" => app_handle.exit(0),
                        _ => {}
                    }
                })
                .build(app)?;

            // The net-worth title, refreshed once a minute while enabled
            // (and cleared when nobody is signed in) -- issue #72 -- and
            // the Refresh Assets items, enabled only while someone is
            // signed in, polled every five seconds (D-048; the session
            // probe does no ledger work).
            {
                let handle_nw = app.handle().clone();
                let show_nw = show_nw.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(8));
                    let mut tick: u32 = 0;
                    let mut last_signed_in: Option<bool> = None;
                    loop {
                        let signed_in = tray_signed_in(port);
                        if last_signed_in != Some(signed_in) {
                            last_signed_in = Some(signed_in);
                            if let Some(items) = handle_nw.try_state::<RefreshItems>() {
                                for item in items.0.lock().expect("refresh items").iter() {
                                    let _ = item.set_enabled(signed_in);
                                }
                            }
                        }
                        if tick % 12 == 0 {
                            let title = if show_nw.load(std::sync::atomic::Ordering::SeqCst) { tray_networth_title(port) } else { None };
                            let handle2 = handle_nw.clone();
                            let _ = handle_nw.run_on_main_thread(move || {
                                if let Some(tray) = handle2.tray_by_id("fin-tray") {
                                    let _ = tray.set_title(title.as_deref());
                                }
                            });
                        }
                        tick = tick.wrapping_add(1);
                        std::thread::sleep(Duration::from_secs(5));
                    }
                });
            }

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
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
                // An extra window (File > New Window) simply closes.
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
