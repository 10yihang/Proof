//! Official Tauri updater behind a narrow, main-window-only IPC surface.
//! The renderer never supplies an endpoint, signature, executable or bytes.
use crate::AppState;
use proof_core::Error;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{ipc::Channel, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const LATEST_RELEASE: &str = "https://github.com/10yihang/Proof/releases/latest";
const RELEASE_ROOT: &str = "https://github.com/10yihang/Proof/releases/tag/";
const ASSET_ROOT: &str = "https://github.com/10yihang/Proof/releases/download/";

// GitHub's public latest-release redirect has no authenticated API dependency.
// Resolve a version first: legacy 0.1.0 has no updater manifest and must not
// produce a missing-feed error for equal/newer installed clients.
fn release_endpoint(
    location: &str,
    current: &semver::Version,
) -> Result<Option<reqwest::Url>, Error> {
    let invalid = || failure("UPDATE_FEED_INVALID", "更新信息格式无效，请稍后重试。");
    let release = reqwest::Url::parse(LATEST_RELEASE)
        .unwrap()
        .join(location)
        .map_err(|_| invalid())?;
    let tag = release
        .as_str()
        .strip_prefix(RELEASE_ROOT)
        .ok_or_else(|| failure("UPDATE_SOURCE_INVALID", "更新包来源无效，下载已停止。"))?;
    let version = tag
        .strip_prefix('v')
        .unwrap_or(tag)
        .parse::<semver::Version>()
        .map_err(|_| invalid())?;
    if !version.pre.is_empty() {
        return Err(invalid());
    }
    if version <= *current {
        return Ok(None);
    }
    Ok(Some(
        format!("{ASSET_ROOT}{tag}/latest.json")
            .parse()
            .map_err(|_| invalid())?,
    ))
}
fn response_error(response: &reqwest::Response) -> Error {
    let (code, message) = if response.status().as_u16() == 429
        || response
            .headers()
            .get("x-ratelimit-remaining")
            .is_some_and(|value| value == "0")
    {
        (
            "UPDATE_RATE_LIMITED",
            "GitHub 暂时限制了更新检查，请稍后重试。",
        )
    } else {
        (
            "UPDATE_FEED_UNAVAILABLE",
            "暂时无法获取更新信息，请稍后重试。",
        )
    };
    Error::new(
        code,
        message,
        format!("GitHub Releases: HTTP {}", response.status().as_u16()),
    )
}
async fn latest_release_endpoint(current: &semver::Version) -> Result<Option<reqwest::Url>, Error> {
    // Match Tauri's TLS provider before initializing our metadata client.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let network = || {
        failure(
            "UPDATE_NETWORK",
            "无法连接 GitHub，请检查网络或代理后重试。",
        )
    };
    let client = reqwest::Client::builder()
        .user_agent(concat!("Proof/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| network())?;
    let response = client
        .head(LATEST_RELEASE)
        .send()
        .await
        .map_err(|_| network())?;
    if !response.status().is_redirection() {
        return Err(response_error(&response));
    }
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| failure("UPDATE_FEED_INVALID", "更新信息格式无效，请稍后重试。"))?;
    let Some(endpoint) = release_endpoint(location, current)? else {
        return Ok(None);
    };
    // Distinguish an unfinished release from a server/network failure. The
    // signed manifest and archive are still read/verified by Tauri itself.
    let manifest = client
        .head(endpoint.clone())
        .send()
        .await
        .map_err(|_| network())?;
    if manifest.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(failure(
            "UPDATE_NOT_PUBLISHED",
            "发现新版本，但该版本尚未提供应用内更新包。",
        ));
    }
    if !manifest.status().is_success() && !manifest.status().is_redirection() {
        return Err(response_error(&manifest));
    }
    Ok(Some(endpoint))
}

#[derive(Default)]
pub struct UpdateState {
    busy: AtomicBool,
    pending: Mutex<Option<Pending>>,
}
struct Pending {
    id: String,
    update: Update,
    bytes: Option<Arc<Vec<u8>>>,
}
struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl UpdateState {
    fn begin(&self) -> Result<Busy<'_>, Error> {
        if self.busy.swap(true, Ordering::AcqRel) {
            return Err(failure("UPDATE_BUSY", "更新操作正在进行。"));
        }
        Ok(Busy(&self.busy))
    }
    fn pending(&self) -> Result<std::sync::MutexGuard<'_, Option<Pending>>, Error> {
        self.pending
            .lock()
            .map_err(|_| failure("UPDATE_UNAVAILABLE", "更新状态不可用，请重启 Proof。"))
    }
}
fn failure(code: &str, message: &str) -> Error {
    Error::new(code, message, code)
}
fn authorize(window: &tauri::WebviewWindow) -> Result<(), Error> {
    if window.label() != "main" {
        return Err(failure("UPDATE_MAIN_WINDOW", "请在主窗口中检查软件更新。"));
    }
    Ok(())
}
fn update_error(error: tauri_plugin_updater::Error) -> Error {
    use tauri_plugin_updater::Error as E;
    let (code, message) = match &error {
        E::ReleaseNotFound => (
            "UPDATE_FEED_UNAVAILABLE",
            "暂时无法获取更新信息，请稍后重试。",
        ),
        E::TargetNotFound(_) | E::TargetsNotFound(_) => (
            "UPDATE_PLATFORM_UNAVAILABLE",
            "此版本尚未提供当前平台的更新包。",
        ),
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) => (
            "UPDATE_SIGNATURE_INVALID",
            "更新包签名校验失败，安装已停止。",
        ),
        E::Io(_) | E::AuthenticationFailed => (
            "UPDATE_INSTALL_FAILED",
            "无法安装更新，请检查应用目录权限后重试。",
        ),
        _ => ("UPDATE_FAILED", "更新失败，请检查网络后重试。"),
    };
    // Endpoint and signature errors are represented by a stable code. Never
    // render arbitrary remote response bodies or release URLs as error HTML.
    failure(code, message)
}
fn trusted_asset(update: &Update) -> bool {
    let url = &update.download_url;
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.path().starts_with("/10yihang/Proof/releases/download/")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    id: String,
    version: String,
    current_version: String,
    notes: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    downloaded: u64,
    total: Option<u64>,
}

#[tauri::command]
pub async fn check_app_update(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, UpdateState>,
) -> Result<Option<UpdateInfo>, Error> {
    authorize(&window)?;
    let _busy = state.begin()?;
    let Some(endpoint) =
        latest_release_endpoint(&window.app_handle().package_info().version).await?
    else {
        *state.pending()? = None;
        return Ok(None);
    };
    let update = window
        .app_handle()
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(update_error)?
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(update_error)?
        .check()
        .await
        .map_err(update_error)?;
    let Some(mut update) = update else {
        *state.pending()? = None;
        return Ok(None);
    };
    if !trusted_asset(&update) {
        return Err(failure(
            "UPDATE_SOURCE_INVALID",
            "更新包来源无效，下载已停止。",
        ));
    }
    update.timeout = Some(Duration::from_secs(300));
    let id = uuid::Uuid::new_v4().to_string();
    let info = UpdateInfo {
        id: id.clone(),
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update
            .body
            .clone()
            .unwrap_or_default()
            .chars()
            .take(20_000)
            .collect(),
    };
    *state.pending()? = Some(Pending {
        id,
        update,
        bytes: None,
    });
    Ok(Some(info))
}

#[tauri::command]
pub async fn download_app_update(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, UpdateState>,
    id: String,
    on_progress: Channel<DownloadProgress>,
) -> Result<(), Error> {
    authorize(&window)?;
    let _busy = state.begin()?;
    let update = state
        .pending()?
        .as_ref()
        .filter(|p| p.id == id)
        .map(|p| p.update.clone())
        .ok_or_else(|| failure("UPDATE_STALE", "更新信息已失效，请重新检查。"))?;
    let mut downloaded = 0u64;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                let _ = on_progress.send(DownloadProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(update_error)?;
    // download() returns only AFTER Tauri has verified the package signature.
    let mut pending = state.pending()?;
    let pending = pending
        .as_mut()
        .filter(|p| p.id == id)
        .ok_or_else(|| failure("UPDATE_STALE", "更新信息已失效，请重新检查。"))?;
    pending.bytes = Some(Arc::new(bytes));
    Ok(())
}

#[tauri::command]
pub async fn install_app_update(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, UpdateState>,
    core: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), Error> {
    authorize(&window)?;
    let _busy = state.begin()?;
    let (update, bytes) = state
        .pending()?
        .as_ref()
        .filter(|p| p.id == id)
        .and_then(|p| {
            p.bytes
                .as_ref()
                .map(|bytes| (p.update.clone(), bytes.clone()))
        })
        .ok_or_else(|| failure("UPDATE_NOT_DOWNLOADED", "请先下载更新。"))?;
    let core = core.0.clone()?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Git mutations hold this same mutex. Keep it until restart so no new
        // mutation or AI task can slip between the idle check and installation.
        let proof = core.try_lock().map_err(|_| {
            failure(
                "UPDATE_WORK_RUNNING",
                "请等待 Git 操作或 AI 分析完成后再安装更新。",
            )
        })?;
        if proof.has_active_ai_task() {
            return Err(failure(
                "UPDATE_WORK_RUNNING",
                "请等待 Git 操作或 AI 分析完成后再安装更新。",
            ));
        }
        update.install(bytes.as_slice()).map_err(update_error)?;
        app.restart();
    })
    .await
    .map_err(|_| {
        failure(
            "UPDATE_INSTALL_FAILED",
            "无法安装更新，请检查应用目录权限后重试。",
        )
    })?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_release_without_manifest_is_current_only_if_not_newer() {
        let current = "0.1.1".parse().unwrap();
        assert!(release_endpoint(&format!("{RELEASE_ROOT}v0.1.0"), &current)
            .unwrap()
            .is_none());
        assert!(release_endpoint(&format!("{RELEASE_ROOT}v0.1.1"), &current)
            .unwrap()
            .is_none());
        assert!(release_endpoint(&format!("{RELEASE_ROOT}v0.1.2"), &current)
            .unwrap()
            .is_some());
    }
    #[test]
    fn newer_release_pins_the_manifest_to_its_tag_and_rejects_other_sources() {
        let current = "0.1.1".parse().unwrap();
        for url in [
            format!("{RELEASE_ROOT}v0.2.0"),
            "/10yihang/Proof/releases/tag/v0.2.0".into(),
        ] {
            assert_eq!(
                release_endpoint(&url, &current).unwrap().unwrap().as_str(),
                "https://github.com/10yihang/Proof/releases/download/v0.2.0/latest.json"
            );
        }
        for url in [
            "https://example.invalid/v0.2.0",
            "https://github.com/other/repo/releases/tag/v0.2.0",
            "http://github.com/10yihang/Proof/releases/tag/v0.2.0",
        ] {
            assert_eq!(
                release_endpoint(url, &current).unwrap_err().code,
                "UPDATE_SOURCE_INVALID"
            );
        }
        for tag in [
            "bad-version",
            "v0.2.0-beta.1",
            "v0.2.0?extra=true",
            "v0.2.0/latest.json",
        ] {
            assert_eq!(
                release_endpoint(&format!("{RELEASE_ROOT}{tag}"), &current)
                    .unwrap_err()
                    .code,
                "UPDATE_FEED_INVALID"
            );
        }
    }
    #[test]
    #[ignore = "Read-only public GitHub check; requires network"]
    fn live_release_check_uses_the_production_resolver() {
        let endpoint = tauri::async_runtime::block_on(latest_release_endpoint(
            &env!("CARGO_PKG_VERSION").parse().unwrap(),
        ))
        .unwrap();
        if let Some(endpoint) = endpoint {
            assert!(endpoint.as_str().starts_with(ASSET_ROOT));
        }
    }
    #[test]
    fn update_ownership_is_released_on_failure_and_excludes_overlap() {
        let state = UpdateState::default();
        {
            let _busy = state.begin().unwrap();
            assert!(state.begin().is_err());
        }
        assert!(state.begin().is_ok());
    }
    #[test]
    fn absent_or_invalid_feed_is_not_reported_as_up_to_date() {
        assert_eq!(
            update_error(tauri_plugin_updater::Error::ReleaseNotFound).code,
            "UPDATE_FEED_UNAVAILABLE"
        );
    }
}
