//! One native confirmation for application exits and main-window closes.
use proof_core::UiLanguage;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

const IDLE: u8 = 0;
const PROMPTING: u8 = 1;
const CONFIRMED: u8 = 2;

#[derive(Default)]
pub struct QuitState {
    phase: AtomicU8,
    english: AtomicBool,
}

impl QuitState {
    pub fn set_language(&self, language: UiLanguage) {
        self.english
            .store(language == UiLanguage::English, Ordering::Release);
    }

    fn begin(&self) -> bool {
        self.phase
            .compare_exchange(IDLE, PROMPTING, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    fn resolve(&self, confirmed: bool) {
        self.phase
            .store(if confirmed { CONFIRMED } else { IDLE }, Ordering::Release);
    }

    fn confirm_exit(&self, code: Option<i32>) -> bool {
        // The updater has already confirmed installation and must restart
        // without a second prompt or a parked native sheet.
        code != Some(tauri::RESTART_EXIT_CODE) && self.phase.load(Ordering::Acquire) != CONFIRMED
    }

    fn confirm_window_close(&self, label: &str) -> bool {
        label == "main" && self.confirm_exit(None)
    }
}

pub fn request(app: &AppHandle) {
    let state = app.state::<QuitState>();
    if !state.begin() {
        return;
    }
    // Language is cached at startup and after language reads/writes. An exit
    // prompt must never wait for a Git operation to release the Core mutex.
    let english = state.english.load(Ordering::Acquire);
    let (title, message, quit, cancel) = if english {
        (
            "Quit Proof?",
            "Unsaved edits may be lost.",
            "Quit",
            "Cancel",
        )
    } else {
        ("退出 Proof？", "未保存的编辑可能丢失。", "退出", "取消")
    };
    let mut dialog =
        app.dialog()
            .message(message)
            .title(title)
            .buttons(MessageDialogButtons::OkCancelCustom(
                quit.into(),
                cancel.into(),
            ));
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.parent(&window);
    }
    let target = app.clone();
    dialog.show(move |confirmed| {
        target.state::<QuitState>().resolve(confirmed);
        if confirmed {
            // Mark approval before generating ExitRequested so this request
            // cannot open the same confirmation again.
            target.exit(0);
        }
    });
}

pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if window
            .state::<QuitState>()
            .confirm_window_close(window.label())
        {
            api.prevent_close();
            request(window.app_handle());
        }
    }
}

pub fn on_run_event(app: &AppHandle, event: tauri::RunEvent) {
    if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
        if app.state::<QuitState>().confirm_exit(code) {
            api.prevent_exit();
            request(app);
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use objc2::{
        runtime::{AnyClass, AnyObject, ClassBuilder, Sel},
        sel, MainThreadMarker,
    };
    use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
    use std::{io, sync::OnceLock};

    static APP: OnceLock<AppHandle> = OnceLock::new();

    extern "C-unwind" fn should_terminate(
        _delegate: &AnyObject,
        _selector: Sel,
        _application: &NSApplication,
    ) -> NSApplicationTerminateReply {
        if let Some(app) = APP.get() {
            if !app.state::<QuitState>().confirm_exit(None) {
                return NSApplicationTerminateReply::TerminateNow;
            }
            request(app);
        }
        // Dock Quit and other AppKit terminate: actions do not generate a
        // Tauri ExitRequested. Cancel the native request while our sheet is
        // pending; explicit confirmation exits through AppHandle::exit.
        NSApplicationTerminateReply::TerminateCancel
    }

    fn delegate_class(parent: &'static AnyClass) -> io::Result<&'static AnyClass> {
        let name = c"ProofQuitApplicationDelegate";
        if let Some(class) = AnyClass::get(name) {
            if class.superclass() == Some(parent) && class.instance_size() == parent.instance_size()
            {
                return Ok(class);
            }
            return Err(io::Error::other(
                "Quit delegate class has an incompatible layout",
            ));
        }
        let mut builder = ClassBuilder::new(name, parent)
            .ok_or_else(|| io::Error::other("Could not create the quit delegate class"))?;
        // SAFETY: The selector is an AppKit NSApplicationDelegate callback
        // with its documented argument/return encoding. No ivars are added.
        unsafe {
            builder.add_method(
                sel!(applicationShouldTerminate:),
                should_terminate as extern "C-unwind" fn(_, _, _) -> _,
            );
        }
        Ok(builder.register())
    }

    pub fn install(app: &AppHandle) -> io::Result<()> {
        let marker = MainThreadMarker::new().ok_or_else(|| {
            io::Error::other("Quit delegate must be installed on the main thread")
        })?;
        let delegate = NSApplication::sharedApplication(marker)
            .delegate()
            .ok_or_else(|| io::Error::other("Native application delegate is unavailable"))?;
        let object = AsRef::<AnyObject>::as_ref(&*delegate);
        let parent = object.class();
        if parent
            .instance_method(sel!(applicationShouldTerminate:))
            .is_some()
        {
            return Err(io::Error::other(
                "Native application delegate already handles termination",
            ));
        }
        let class = delegate_class(parent)?;
        APP.set(app.clone())
            .map_err(|_| io::Error::other("Quit delegate was already installed"))?;
        // SAFETY: This runs once on the main thread during setup. The new
        // class is a direct subclass with exactly the same instance size and
        // no new ivars. Every existing Tao delegate method and its ownership
        // remain inherited; only the optional termination callback is added.
        let previous = unsafe { AnyObject::set_class(object, class) };
        assert_eq!(
            previous, parent,
            "Native delegate changed during quit-hook setup"
        );
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use objc2::{runtime::NSObject, ClassType};

        #[test]
        fn quit_delegate_adds_only_termination_callback_and_preserves_native_layout() {
            let parent = NSObject::class();
            let class = delegate_class(parent).unwrap();
            assert_eq!(class.superclass(), Some(parent));
            assert_eq!(class.instance_size(), parent.instance_size());
            assert!(class
                .instance_method(sel!(applicationShouldTerminate:))
                .is_some());
            assert!(std::ptr::eq(
                parent.instance_method(sel!(dealloc)).unwrap(),
                class.instance_method(sel!(dealloc)).unwrap(),
            ));
        }
    }
}

#[cfg(target_os = "macos")]
pub use macos::install;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_exit_requests_share_one_prompt_and_cancel_allows_retry() {
        let state = QuitState::default();
        assert!(state.begin());
        assert!(!state.begin());
        assert!(state.confirm_exit(None));
        state.resolve(false);
        assert!(state.confirm_window_close("main"));
        assert!(state.begin());
    }

    #[test]
    fn explicit_confirmation_allows_exit_without_a_recursive_prompt() {
        let state = QuitState::default();
        assert!(state.begin());
        state.resolve(true);
        assert!(!state.confirm_exit(Some(0)));
        assert!(!state.confirm_window_close("main"));
        assert!(!state.begin());
    }

    #[test]
    fn diff_window_closes_and_update_restarts_do_not_require_confirmation() {
        let state = QuitState::default();
        assert!(!state.confirm_window_close("proof-diff-1"));
        assert!(!state.confirm_exit(Some(tauri::RESTART_EXIT_CODE)));
        assert!(state.confirm_exit(None));
        assert!(state.confirm_exit(Some(0)));
    }
}
