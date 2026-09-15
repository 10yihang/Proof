use objc2::MainThreadMarker;
use objc2_app_kit::NSApplication;
use tauri::{
    menu::{
        AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu, WINDOW_SUBMENU_ID,
    },
    AppHandle, Emitter, Manager,
};

pub fn create(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    localized(app, proof_core::UiLanguage::default())
}

fn localized(app: &AppHandle, language: proof_core::UiLanguage) -> tauri::Result<Menu<tauri::Wry>> {
    let text = |zh, en| {
        if language == proof_core::UiLanguage::Chinese {
            zh
        } else {
            en
        }
    };
    let application = Submenu::with_items(
        app,
        "Proof",
        true,
        &[
            &PredefinedMenuItem::about(
                app,
                Some(text("关于 Proof", "About Proof")),
                Some(AboutMetadata {
                    name: Some("Proof".into()),
                    version: Some(app.package_info().version.to_string()),
                    ..Default::default()
                }),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some(text("服务", "Services")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(text("隐藏 Proof", "Hide Proof")))?,
            &PredefinedMenuItem::hide_others(app, Some(text("隐藏其他", "Hide Others")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some(text("退出 Proof", "Quit Proof")))?,
        ],
    )?;
    // AppKit consumes menu accelerators before WebView keydown. Route Cmd+W
    // through the active view rather than the default performClose: selector.
    let file = Submenu::with_items(
        app,
        text("文件", "File"),
        true,
        &[
            &MenuItem::with_id(
                app,
                "proof.close-active-view",
                text("关闭", "Close"),
                true,
                Some("CmdOrCtrl+W"),
            )?,
            &MenuItem::with_id(
                app,
                "proof.close-window",
                text("关闭窗口", "Close Window"),
                true,
                Some("CmdOrCtrl+Shift+W"),
            )?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        text("编辑", "Edit"),
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(text("撤销", "Undo")))?,
            &PredefinedMenuItem::redo(app, Some(text("重做", "Redo")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(text("剪切", "Cut")))?,
            &PredefinedMenuItem::copy(app, Some(text("复制", "Copy")))?,
            &PredefinedMenuItem::paste(app, Some(text("粘贴", "Paste")))?,
            &PredefinedMenuItem::select_all(app, Some(text("全选", "Select All")))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        text("视图", "View"),
        true,
        &[&PredefinedMenuItem::fullscreen(
            app,
            Some(text("进入全屏", "Enter Full Screen")),
        )?],
    )?;
    let window = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        text("窗口", "Window"),
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(text("最小化", "Minimize")))?,
            &PredefinedMenuItem::maximize(app, Some(text("缩放", "Zoom")))?,
        ],
    )?;
    Menu::with_items(app, &[&application, &file, &edit, &view, &window])
}

pub fn handle(app: &AppHandle, event: MenuEvent) {
    let close_view = match event.id().as_ref() {
        "proof.close-active-view" => true,
        "proof.close-window" => false,
        _ => return,
    };
    for window in app.webview_windows().values() {
        match window.is_focused() {
            Ok(true) if close_view => {
                let _ = window.emit("proof:close-active-view", ());
                return;
            }
            Ok(true) => {
                let _ = window.close();
                return;
            }
            Err(_) => continue,
            Ok(false) => {}
        }
    }
    // About and other AppKit panels are not Tauri WebViews. Preserve their
    // standard Close action instead of touching the main window behind them.
    if let Some(main_thread) = MainThreadMarker::new() {
        if let Some(window) = NSApplication::sharedApplication(main_thread).keyWindow() {
            window.performClose(None);
        }
    }
}

// Never wait for the Git/Core mutex on AppKit's main thread.
static MENU_REVISION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub fn refresh(app: &AppHandle) {
    use std::sync::atomic::Ordering;
    let revision = MENU_REVISION.fetch_add(1, Ordering::SeqCst) + 1;
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let language =
            worker
                .try_state::<crate::AppState>()
                .and_then(|state| {
                    state.0.as_ref().ok().and_then(|core| {
                        core.lock().ok().and_then(|proof| proof.ui_language().ok())
                    })
                })
                .unwrap_or_default();
        let target = worker.clone();
        let _ = worker.run_on_main_thread(move || {
            if MENU_REVISION.load(Ordering::SeqCst) == revision {
                if let Ok(menu) = localized(&target, language) {
                    let _ = target.set_menu(menu);
                }
            }
        });
    });
}
