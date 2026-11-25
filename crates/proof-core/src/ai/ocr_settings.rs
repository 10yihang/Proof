use super::{invalid, ocr, ocr_git::OcrGitPlan, provider, AgentKind, AgentProgram, OcrPreview};
use crate::{
    fingerprint,
    guarded_file::{BoundFile, FileImage},
    Error, Proof, Result, Side,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

const DIRECTORY: &str = ".opencodereview";
const CONFIG: &str = ".opencodereview/config.json";
const RULES: &str = ".opencodereview/rule.json";
const SETTINGS_LIMIT: usize = 512 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrSettings {
    pub fingerprint: String,
    pub provider: String,
    pub model: String,
    pub language: String,
    pub effort: String,
    pub providers: Vec<OcrProviderSettings>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrProviderSettings {
    pub id: String,
    pub model: String,
    pub models: Vec<String>,
    pub saved_key: bool,
    pub endpoint: Option<OcrEndpoint>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OcrEndpoint {
    pub url: String,
    pub protocol: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OcrSettingsUpdate {
    pub expected_fingerprint: String,
    pub provider: String,
    pub model: String,
    pub language: String,
    pub effort: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub endpoint: Option<OcrEndpoint>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrRules {
    pub content: String,
    pub fingerprint: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OcrComparison {
    pub base: String,
    pub target: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct OcrRuleMatch {
    pub source: String,
    pub pattern: Option<String>,
    pub rule: String,
}

fn user_directory() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| invalid("Unable to locate OpenCodeReview user settings"))
}

fn config_directory(root: &Path, create: bool) -> Result<bool> {
    let directory = root.join(DIRECTORY);
    if create {
        match fs::create_dir(&directory) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error.into()),
        }
    }
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.is_dir() => Ok(true),
        Ok(_) => Err(Error::new(
            "OCR_SETTINGS_PATH",
            "OpenCodeReview 配置目录需要是普通目录。",
            DIRECTORY,
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn image(root: &Path, relative: &str) -> Result<Option<FileImage>> {
    if !config_directory(root, false)? {
        return Ok(None);
    }
    let value = BoundFile::open(root, relative)?.read()?;
    if value
        .as_ref()
        .is_some_and(|file| file.bytes.len() > SETTINGS_LIMIT)
    {
        return Err(Error::new(
            "OCR_SETTINGS_SIZE",
            "OpenCodeReview 配置超过读取上限。",
            relative,
        ));
    }
    Ok(value)
}

fn version(image: &Option<FileImage>) -> String {
    image
        .as_ref()
        .map(|file| fingerprint(&[&file.bytes]))
        .unwrap_or_default()
}

fn replace_user_file(
    root: &Path,
    relative: &str,
    before: &Option<FileImage>,
    bytes: Vec<u8>,
) -> Result<()> {
    config_directory(root, true)?;
    let file = BoundFile::open(root, relative)?;
    let staging = tempfile::Builder::new()
        .prefix("proof-ocr-")
        .tempdir_in(root.join(DIRECTORY))?;
    let desired = FileImage {
        mode: 0o600,
        identity: String::new(),
        bytes,
    };
    let backup = staging.path().join("backup");
    let candidate = staging.path().join("candidate");
    if let Err(error) = file.replace(before, &Some(desired), &backup, &candidate, None) {
        if backup.is_file() {
            let _ = staging.keep();
            return Err(Error::new(
                "OCR_SETTINGS_RECOVERY",
                "OCR 配置更新未完成，原配置已保存在恢复副本中。",
                backup.display(),
            ));
        }
        return Err(error);
    }
    Ok(())
}

fn config(image: &Option<FileImage>) -> Result<Value> {
    let value: Value = image
        .as_ref()
        .map(|file| serde_json::from_slice(&file.bytes))
        .transpose()
        .map_err(|_| {
            Error::new(
                "OCR_SETTINGS_JSON",
                "OpenCodeReview 本机配置不是有效的 JSON。",
                CONFIG,
            )
        })?
        .unwrap_or_else(|| json!({}));
    if !value.is_object() {
        return Err(invalid("Expected an OpenCodeReview configuration object"));
    }
    Ok(value)
}

fn settings(value: &Value, fingerprint: String) -> OcrSettings {
    let text = |name: &str| value[name].as_str().unwrap_or_default().to_owned();
    let provider = text("provider");
    let providers = ["providers", "custom_providers"]
        .into_iter()
        .filter_map(|key| value[key].as_object())
        .flat_map(|entries| entries.keys().cloned())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .map(|id| {
            let custom = &value["custom_providers"][&id];
            let entry = if custom.is_object() {
                custom
            } else {
                &value["providers"][&id]
            };
            let text = |name: &str| entry[name].as_str().unwrap_or_default().to_owned();
            OcrProviderSettings {
                model: text("model"),
                models: entry["models"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
                saved_key: !text("api_key").is_empty(),
                endpoint: custom.is_object().then(|| OcrEndpoint {
                    url: text("url"),
                    protocol: text("protocol"),
                }),
                id,
            }
        })
        .collect();
    let entry = if value["custom_providers"][&provider].is_object() {
        &value["custom_providers"][&provider]
    } else {
        &value["providers"][&provider]
    };
    let mut model = text("model");
    if model.is_empty() {
        model = entry["model"]
            .as_str()
            .or_else(|| value["llm"]["model"].as_str())
            .unwrap_or_default()
            .into();
    }
    OcrSettings {
        fingerprint,
        model,
        provider,
        language: text("language"),
        effort: text("effort"),
        providers,
    }
}

fn apply_config(value: &mut Value, update: OcrSettingsUpdate) -> Result<()> {
    let provider = update.provider.trim();
    let model = update.model.trim();
    let language = update.language.trim();
    let key = update.api_key.trim();
    let endpoint = update.endpoint.as_ref();
    if provider.len() > 100
        || provider
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
        || model.len() > 200
        || model.chars().any(|c| c.is_whitespace() || c.is_control())
        || language.len() > 100
        || language.chars().any(char::is_control)
        || key.len() > 8192
        || key.chars().any(char::is_control)
        || !matches!(update.effort.as_str(), "" | "low" | "medium" | "high")
        || (provider.is_empty() && !key.is_empty())
        || endpoint.is_some_and(|endpoint| {
            let url = endpoint.url.trim();
            provider.is_empty()
                || provider == "chatgpt"
                || !matches!(
                    endpoint.protocol.as_str(),
                    "openai" | "openai-responses" | "anthropic" | "anthropic-bedrock"
                )
                || (!(endpoint.protocol == "anthropic-bedrock" && url.is_empty())
                    && (!url
                        .strip_prefix("https://")
                        .or_else(|| url.strip_prefix("http://"))
                        .is_some_and(|host| !host.is_empty())
                        || url
                            .chars()
                            .any(|character| character.is_control() || character.is_whitespace())))
        })
    {
        return Err(Error::new(
            "OCR_SETTINGS_VALUE",
            "请检查 Provider、模型或审查设置。",
            "Invalid OpenCodeReview settings",
        ));
    }
    let values = value
        .as_object_mut()
        .expect("OCR configuration was validated");
    for (name, field) in [
        ("provider", provider),
        ("model", model),
        ("language", language),
        ("effort", &update.effort),
    ] {
        if field.is_empty() {
            values.remove(name);
        } else {
            values.insert(name.into(), json!(field));
        }
    }
    let section = if endpoint.is_some() || value["custom_providers"][provider].is_object() {
        "custom_providers"
    } else {
        "providers"
    };
    if !provider.is_empty()
        && (!model.is_empty()
            || !key.is_empty()
            || endpoint.is_some()
            || value[section][provider].is_object())
    {
        if value[section].is_null() {
            value[section] = json!({});
        }
        if !value[section].is_object() {
            return Err(invalid("Expected provider configuration object"));
        }
        if value[section][provider].is_null() {
            value[section][provider] = json!({});
        }
        let entry = value[section][provider]
            .as_object_mut()
            .ok_or_else(|| invalid("Expected named provider configuration"))?;
        if !model.is_empty() {
            entry.insert("model".into(), json!(model));
        } else {
            entry.remove("model");
        }
        if !key.is_empty() {
            entry.insert("api_key".into(), json!(key));
        }
        if let Some(endpoint) = endpoint {
            entry.insert("url".into(), json!(endpoint.url.trim()));
            entry.insert("protocol".into(), json!(endpoint.protocol));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn global_rules_save_to_the_cli_file_and_reject_stale_edits() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::create_dir(root.join(DIRECTORY)).unwrap();
        fs::write(root.join(CONFIG), b"{}").unwrap();
        assert!(read_rules(root).unwrap().fingerprint.is_empty());

        let content =
            r#"{"rules":[{"path":"**/*.go","rule":"Check errors","merge_system_rule":true}]}"#;
        let saved = save_global_rules(root, content, "").unwrap();
        assert_eq!(saved.content, content);
        assert_eq!(fs::read_to_string(root.join(RULES)).unwrap(), content);
        assert_eq!(fs::read(root.join(CONFIG)).unwrap(), b"{}");
        assert_eq!(
            save_global_rules(root, "{}", "").unwrap_err().code,
            "STALE_CONTENT"
        );
        assert_eq!(read_rules(root).unwrap().fingerprint, saved.fingerprint);
    }

    #[test]
    fn ocr_custom_provider_edit_preserves_credentials_and_models_without_returning_the_key() {
        let mut config = json!({
            "provider": "gateway",
            "custom_providers": {
                "gateway": { "api_key": "fixture-secret", "models": ["existing"], "extra_body": { "tool_choice": "auto" } },
                "other": { "url": "https://other.example/v1" }
            }
        });
        apply_config(
            &mut config,
            OcrSettingsUpdate {
                expected_fingerprint: String::new(),
                provider: "gateway".into(),
                model: "new-model".into(),
                language: "English".into(),
                effort: "medium".into(),
                api_key: String::new(),
                endpoint: Some(OcrEndpoint {
                    url: "https://gateway.example/v1".into(),
                    protocol: "openai-responses".into(),
                }),
            },
        )
        .unwrap();
        let gateway = &config["custom_providers"]["gateway"];
        assert_eq!(gateway["url"], "https://gateway.example/v1");
        assert_eq!(gateway["model"], "new-model");
        assert_eq!(gateway["api_key"], "fixture-secret");
        assert_eq!(gateway["extra_body"]["tool_choice"], "auto");
        assert_eq!(
            config["custom_providers"]["other"]["url"],
            "https://other.example/v1"
        );
        let view = serde_json::to_value(settings(&config, String::new())).unwrap();
        assert_eq!(view["providers"][0]["models"], json!(["existing"]));
        assert_eq!(view["providers"][0]["savedKey"], true);
        assert!(!view.to_string().contains("fixture-secret"));
    }
}

fn validate_rules(content: &str) -> Result<()> {
    let error = || Error::new("OCR_RULES_JSON", "请输入有效的 OCR 规则 JSON。", RULES);
    if content.len() > SETTINGS_LIMIT {
        return Err(error());
    }
    let value: Value = serde_json::from_str(content).map_err(|_| error())?;
    if !value.is_object() {
        return Err(error());
    }
    for key in ["include", "exclude"] {
        if let Some(field) = value.get(key) {
            if !field.is_null()
                && !field
                    .as_array()
                    .is_some_and(|items| items.iter().all(Value::is_string))
            {
                return Err(error());
            }
        }
    }
    if let Some(field) = value.get("rules") {
        if !field.is_null()
            && !field.as_array().is_some_and(|entries| {
                entries.iter().all(|entry| {
                    entry["path"].is_string()
                        && entry["rule"].is_string()
                        && entry
                            .get("merge_system_rule")
                            .is_none_or(|merge| merge.is_boolean() || merge.is_null())
                })
            })
        {
            return Err(error());
        }
    }
    Ok(())
}

fn draft_preview_rules(content: &str) -> Result<String> {
    validate_rules(content)?;
    let draft: Value = serde_json::from_str(content)?;
    let mut value = json!({"include": draft["include"], "exclude": draft["exclude"]});
    let has_filters = |value: &Value| {
        ["include", "exclude"].iter().any(|key| {
            value[*key]
                .as_array()
                .is_some_and(|items| !items.is_empty())
        })
    };
    if !has_filters(&value) {
        // With no filters of its own, a saved project rule inherits the
        // global filter. A draft passed as --rule would otherwise inherit
        // the existing project's filters instead.
        let global = image(&user_directory()?, RULES)?;
        if let Some(file) = global {
            let global: Value = serde_json::from_slice(&file.bytes)?;
            value["include"] = global["include"].clone();
            value["exclude"] = global["exclude"].clone();
        }
        if !has_filters(&value) {
            value["exclude"] = json!([".git/**"]);
        }
    }
    Ok(serde_json::to_string(&value)?)
}

fn read_rules(root: &Path) -> Result<OcrRules> {
    let saved = image(root, RULES)?;
    Ok(OcrRules {
        fingerprint: version(&saved),
        content: saved
            .map(|file| String::from_utf8_lossy(&file.bytes).into_owned())
            .unwrap_or_else(|| {
                "{\n  \"include\": [],\n  \"exclude\": [],\n  \"rules\": []\n}\n".into()
            }),
    })
}

fn save_global_rules(root: &Path, content: &str, expected: &str) -> Result<OcrRules> {
    validate_rules(content)?;
    let before = image(root, RULES)?;
    if version(&before) != expected {
        return Err(Error::stale());
    }
    replace_user_file(root, RULES, &before, content.as_bytes().to_vec())?;
    read_rules(root)
}

impl Proof {
    pub fn ocr_settings(&self) -> Result<OcrSettings> {
        let image = image(&user_directory()?, CONFIG)?;
        Ok(settings(&config(&image)?, version(&image)))
    }

    pub fn set_ocr_settings(&self, update: OcrSettingsUpdate) -> Result<OcrSettings> {
        let root = user_directory()?;
        let before = image(&root, CONFIG)?;
        if version(&before) != update.expected_fingerprint {
            return Err(Error::stale());
        }
        let mut value = config(&before)?;
        apply_config(&mut value, update)?;
        let mut bytes = serde_json::to_vec_pretty(&value)?;
        bytes.push(b'\n');
        replace_user_file(&root, CONFIG, &before, bytes)?;
        self.ocr_settings()
    }

    pub fn ocr_global_rules(&self) -> Result<OcrRules> {
        read_rules(&user_directory()?)
    }

    pub fn set_ocr_global_rules(&self, content: &str, expected: &str) -> Result<OcrRules> {
        save_global_rules(&user_directory()?, content, expected)
    }

    pub fn ocr_rules(&self, workspace_id: &str) -> Result<OcrRules> {
        let workspace = self.store.workspace(workspace_id)?;
        read_rules(Path::new(&workspace.path))
    }

    pub fn set_ocr_rules(
        &self,
        workspace_id: &str,
        content: &str,
        expected: &str,
    ) -> Result<OcrRules> {
        validate_rules(content)?;
        let workspace = self.store.workspace(workspace_id)?;
        self.require_write(&workspace)?;
        config_directory(Path::new(&workspace.path), true)?;
        self.save_text_file(workspace_id, RULES, content, Some(expected))?;
        self.ocr_rules(workspace_id)
    }

    fn ocr_program(&self, workspace: Option<&str>) -> Result<AgentProgram> {
        AgentProgram::configured(
            AgentKind::Ocr,
            &self.data_dir,
            workspace,
            self.cached_data_epoch,
            &self.agent_settings()?.ocr,
        )
    }

    pub fn prepare_ocr_connection(&self) -> Result<OcrConnection> {
        Ok(OcrConnection(self.ocr_program(None)?))
    }

    pub fn prepare_ocr_preview(
        &self,
        workspace_id: &str,
        rules: Option<String>,
        comparison: Option<OcrComparison>,
    ) -> Result<OcrPreviewJob> {
        self.prepare_ocr_preview_with_side(workspace_id, rules, comparison, None)
    }

    pub fn prepare_ocr_preview_with_side(
        &self,
        workspace_id: &str,
        rules: Option<String>,
        comparison: Option<OcrComparison>,
        side: Option<Side>,
    ) -> Result<OcrPreviewJob> {
        let workspace = self.store.workspace(workspace_id)?;
        if !workspace.trusted {
            return Err(Error::new(
                "TRUST_REQUIRED",
                "请先信任此仓库。",
                "OCR preview requires repository trust",
            ));
        }
        let rules = rules.as_deref().map(draft_preview_rules).transpose()?;
        let mut selected = Vec::new();
        let plan = if let Some(OcrComparison { base, target }) = comparison {
            let comparison = self.frozen_comparison(workspace_id, &base, &target)?;
            Some(OcrGitPlan::comparison(
                self.git()?,
                workspace.clone(),
                comparison.base_oid,
                comparison.target_oid,
            ))
        } else if let Some(side) = side {
            let changes = self.changes(workspace_id)?;
            selected = changes
                .files
                .iter()
                .filter(|f| f.side == side)
                .map(|f| (f.path.clone(), f.side))
                .collect();
            Some(OcrGitPlan::local(self.git()?, changes))
        } else {
            None
        };
        Ok(OcrPreviewJob {
            program: self.ocr_program(Some(workspace_id))?,
            project: fs::canonicalize(&workspace.path)?,
            workspace_id: workspace_id.into(),
            plan,
            selected,
            rules,
        })
    }
}

pub struct OcrConnection(AgentProgram);
impl OcrConnection {
    pub fn run(self) -> Result<()> {
        provider::test_ocr_connection(&self.0)
    }
    pub fn providers(self) -> Result<Vec<String>> {
        provider::ocr_provider_catalog(&self.0)
    }
    pub fn inspect_builtin_rule(self, path: &str) -> Result<OcrRuleMatch> {
        provider::inspect_ocr_builtin_rule(&self.0, path)
    }
}

pub struct OcrPreviewJob {
    program: AgentProgram,
    project: PathBuf,
    workspace_id: String,
    plan: Option<OcrGitPlan>,
    selected: Vec<(String, Side)>,
    rules: Option<String>,
}
impl OcrPreviewJob {
    pub fn run(self) -> Result<OcrPreview> {
        let directory = tempfile::tempdir()?;
        let root = fs::canonicalize(directory.path())?;
        let rules = self.rule_file(&root)?;
        let view = self
            .plan
            .as_ref()
            .map(|plan| plan.capture(&self.selected))
            .transpose()?;
        if view.as_ref().is_some_and(|view| view.ranges.is_empty()) {
            return Ok(OcrPreview { files: Vec::new() });
        }
        let scope = view
            .as_ref()
            .and_then(|view| view.ranges.first())
            .map(|range| range.scope(&self.workspace_id, None));
        let flags = scope.as_ref().map_or_else(Vec::new, ocr::scope_flags);
        provider::preview_ocr(
            &self.program,
            &self.project,
            &root,
            &flags,
            rules.as_deref(),
            view.as_ref().map(|view| view.git_dir.as_path()),
        )
    }

    fn rule_file(&self, root: &Path) -> Result<Option<PathBuf>> {
        self.rules
            .as_ref()
            .map(|content| {
                let path = root.join("rule.json");
                fs::write(&path, content)
                    .map(|()| path)
                    .map_err(Error::from)
            })
            .transpose()
    }

    pub fn inspect_rule(self, path: &str) -> Result<OcrRuleMatch> {
        let directory = tempfile::tempdir()?;
        let root = fs::canonicalize(directory.path())?;
        let view = self
            .plan
            .as_ref()
            .map(|plan| plan.capture(&self.selected))
            .transpose()?;
        let scope = view
            .as_ref()
            .and_then(|view| view.ranges.first())
            .map(|range| range.scope(&self.workspace_id, None));
        let flags = scope.as_ref().map_or_else(Vec::new, ocr::scope_flags);
        provider::inspect_ocr_rule(
            &self.program,
            &self.project,
            &root,
            &flags,
            path,
            view.as_ref().map(|view| view.git_dir.as_path()),
        )
    }
}
