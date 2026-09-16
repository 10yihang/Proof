//! Own exactly one local plugin file, leaving all Codewiz JSON and user plugins intact.
use crate::config::{ConfigOwnership, ConfigPlan, HookSpec};
use proof_core::{Error, Result};

pub fn plugin(spec: &HookSpec) -> Result<String> {
    Ok(include_str!("codewiz-plugin.js")
        .replace(
            "__PROOF_HELPER__",
            &serde_json::to_string(&spec.helper_path)?,
        )
        .replace(
            "__PROOF_REGISTRATION__",
            &serde_json::to_string(&spec.registration_path)?,
        ))
}
fn conflict() -> Error {
    Error::new(
        "OBSERVER_CONFIG_CONFLICT",
        "Proof 的 Codewiz 插件文件已存在或被修改，请先核对文件。",
        "Refusing to overwrite or remove an unowned/modified plugin",
    )
}
pub(crate) fn install(
    before: Option<&[u8]>,
    spec: &HookSpec,
    previous: Option<&ConfigOwnership>,
) -> Result<ConfigPlan> {
    let before = before
        .map(|bytes| String::from_utf8(bytes.to_vec()).map_err(|_| conflict()))
        .transpose()?;
    if let Some(text) = &before {
        let owned = previous.ok_or_else(conflict)?;
        if *text != plugin(&owned.spec)? {
            return Err(conflict());
        }
    }
    let after = Some(plugin(spec)?);
    Ok(ConfigPlan {
        changed: before != after,
        before,
        after,
        ownership: ConfigOwnership {
            schema_version: 2,
            spec: spec.clone(),
            created_file: true,
            created_hooks: false,
            created_events: vec![],
        },
    })
}
pub(crate) fn uninstall(before: Option<&[u8]>, owned: &ConfigOwnership) -> Result<ConfigPlan> {
    let before = before
        .map(|bytes| String::from_utf8(bytes.to_vec()).map_err(|_| conflict()))
        .transpose()?;
    if before
        .as_ref()
        .is_some_and(|text| plugin(&owned.spec).as_ref().ok() != Some(text))
    {
        return Err(conflict());
    }
    Ok(ConfigPlan {
        changed: before.is_some(),
        before,
        after: None,
        ownership: owned.clone(),
    })
}
