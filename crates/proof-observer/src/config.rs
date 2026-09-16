//! Provider hook edits preserve the user's JSON bytes outside edited entries.
//! This module plans changes only; it cannot write configuration or grant trust.
use crate::protocol::Agent;
use proof_core::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{ops::Range, path::Path};

const MAX_CONFIG: usize = 1024 * 1024;
const OWNERSHIP_SCHEMA: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookSpec {
    pub installation_id: String,
    pub agent: Agent,
    pub agent_version: String,
    pub helper_path: String,
    pub registration_path: String,
}

impl HookSpec {
    pub fn validate(&self) -> Result<()> {
        self.validate_identity()?;
        if proof_core::observer_adapter_profile(self.agent, &self.agent_version).is_none() {
            return Err(config_error(
                "OBSERVER_VERSION_FORMAT",
                "Agent 版本格式无法识别，请重新检测程序。",
            ));
        }
        Ok(())
    }
    fn validate_identity(&self) -> Result<()> {
        if !cfg!(unix) {
            return Err(config_error(
                "OBSERVER_CONFIG_PLATFORM",
                "当前平台的 Hook 配置方案尚未开放。",
            ));
        }
        if uuid::Uuid::parse_str(&self.installation_id).is_err()
            || !Path::new(&self.helper_path).is_absolute()
            || !Path::new(&self.registration_path).is_absolute()
            || !self.registration_path.contains(&self.installation_id)
            || self.helper_path.contains('\0')
            || self.registration_path.contains('\0')
            || self.helper_path.len() > 32768
            || self.registration_path.len() > 32768
            || self.agent_version.is_empty()
            || self.agent_version.len() > 64
            || self.agent_version.chars().any(char::is_control)
        {
            return Err(config_error(
                "OBSERVER_CONFIG_PATH",
                "观察程序或注册文件路径无效。",
            ));
        }
        Ok(())
    }
    fn events(&self) -> &'static [&'static str] {
        proof_core::observer_hook_events_v1(self.agent)
    }
    pub fn command(&self) -> String {
        format!(
            "{} bridge --registration {}",
            quote(&self.helper_path),
            quote(&self.registration_path)
        )
    }
    fn handler(&self, event: &str, schema: u32) -> Value {
        // A real Codex exec run cancelled its async Stop at session shutdown.
        // Terminal handlers wait only for our self-bounded, silent bridge.
        let asynchronous =
            !(schema >= 2 && self.agent == Agent::Codex && ["Stop", "SessionEnd"].contains(&event));
        json!({"type":"command","command":self.command(),"async":asynchronous,"timeout":1})
    }
    fn group(&self, event: &str, schema: u32) -> Value {
        json!({"hooks":[self.handler(event, schema)]})
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigOwnership {
    pub schema_version: u32,
    pub spec: HookSpec,
    pub created_file: bool,
    pub created_hooks: bool,
    pub created_events: Vec<String>,
}

/// Contains local configuration text, which may include private user settings.
/// Do not include this object in telemetry or diagnostic exports.
pub struct ConfigPlan {
    pub before: Option<String>,
    pub after: Option<String>,
    pub ownership: ConfigOwnership,
    pub changed: bool,
}

pub fn install_plan(
    before: Option<&[u8]>,
    spec: &HookSpec,
    previous: Option<&ConfigOwnership>,
) -> Result<ConfigPlan> {
    spec.validate()?;
    if let Some(previous) = previous {
        validate_ownership(previous)?;
        if previous.spec.installation_id != spec.installation_id
            || previous.spec.agent != spec.agent
        {
            return Err(config_error(
                "OBSERVER_CONFIG_OWNER",
                "已有配置属于另一项观察注册。",
            ));
        }
    }
    if spec.agent == Agent::Codewiz {
        return crate::codewiz::install(before, spec, previous);
    }
    let before = before.map(decode).transpose()?;
    let mut document = Document::parse(before.clone().unwrap_or_else(|| "{}\n".into()))?;
    validate_existing_definition(
        &document.value,
        previous.map(|p| &p.spec).unwrap_or(spec),
        previous
            .map(|p| p.schema_version)
            .unwrap_or(OWNERSHIP_SCHEMA),
    )?;
    let mut ownership = previous.cloned().unwrap_or_else(|| ConfigOwnership {
        schema_version: OWNERSHIP_SCHEMA,
        spec: spec.clone(),
        created_file: before.is_none(),
        created_hooks: false,
        created_events: vec![],
    });
    if let Some(previous) = previous {
        // Updating a helper/version removes only entries owned by the prior
        // receipt, then adds the new definition. User additions stay in place.
        if previous.spec.command() != spec.command()
            || previous.spec.agent_version != spec.agent_version
            || previous.schema_version != OWNERSHIP_SCHEMA
        {
            remove_owned(&mut document, previous, false)?;
        }
    }
    ownership.spec = spec.clone();
    ownership.schema_version = OWNERSHIP_SCHEMA;
    if document.value.get("hooks").is_none() {
        document.add_property(&[], "hooks", &json!({}))?;
        ownership.created_hooks = true;
    }
    if !document.value["hooks"].is_object() {
        return Err(config_error(
            "OBSERVER_CONFIG_SHAPE",
            "现有 hooks 字段不是对象，未生成覆盖方案。",
        ));
    }
    for (event, groups) in document.value["hooks"].as_object().unwrap() {
        if mentions_owner(groups, &spec.installation_id) && !spec.events().contains(&event.as_str())
        {
            return Err(config_error(
                "OBSERVER_CONFIG_CONFLICT",
                "此观察注册已被移到其他事件，请先核对配置。",
            ));
        }
    }
    for event in spec.events() {
        if document.value["hooks"].get(*event).is_none() {
            document.add_property(&["hooks"], event, &json!([]))?;
            if !ownership.created_events.iter().any(|e| e == event) {
                ownership.created_events.push((*event).into());
            }
        }
        let groups = groups(&document.value, event)?;
        let mut present = false;
        for group in groups {
            for handler in handlers(group)? {
                if mentions_owner(handler, &spec.installation_id) {
                    if *handler != spec.handler(event, OWNERSHIP_SCHEMA) {
                        return Err(config_error(
                            "OBSERVER_CONFIG_CONFLICT",
                            "Proof 观察条目已被修改，请先核对配置差异。",
                        ));
                    }
                    present = true;
                }
            }
        }
        if !present {
            document.append(&["hooks", event], &spec.group(event, OWNERSHIP_SCHEMA))?;
        }
    }
    let after = Some(document.text);
    Ok(ConfigPlan {
        changed: before != after,
        before,
        after,
        ownership,
    })
}

pub fn uninstall_plan(before: Option<&[u8]>, ownership: &ConfigOwnership) -> Result<ConfigPlan> {
    validate_ownership(ownership)?;
    if ownership.spec.agent == Agent::Codewiz {
        return crate::codewiz::uninstall(before, ownership);
    }
    let before = before.map(decode).transpose()?;
    let mut document = Document::parse(before.clone().unwrap_or_else(|| "{}\n".into()))?;
    remove_owned(&mut document, ownership, true)?;
    let after = if (before.is_none() || ownership.created_file)
        && document.value.as_object().is_some_and(|m| m.is_empty())
    {
        None
    } else {
        Some(document.text)
    };
    Ok(ConfigPlan {
        changed: before != after,
        before,
        after,
        ownership: ownership.clone(),
    })
}

fn validate_ownership(ownership: &ConfigOwnership) -> Result<()> {
    // Removal uses its recorded schema; an Agent version becoming unsupported
    // must not prevent removal of an already-owned command definition.
    ownership.spec.validate_identity()?;
    if ![1, OWNERSHIP_SCHEMA].contains(&ownership.schema_version)
        || ownership
            .created_events
            .iter()
            .any(|event| !ownership.spec.events().contains(&event.as_str()))
    {
        return Err(config_error(
            "OBSERVER_CONFIG_RECEIPT",
            "观察配置的所有权记录无法读取。",
        ));
    }
    Ok(())
}

fn validate_existing_definition(value: &Value, spec: &HookSpec, schema: u32) -> Result<()> {
    for (key, value) in value.as_object().unwrap() {
        if key != "hooks" && mentions_owner(value, &spec.installation_id) {
            return Err(config_error(
                "OBSERVER_CONFIG_CONFLICT",
                "配置的其他字段仍引用此观察注册，请先核对。",
            ));
        }
    }
    let Some(hooks) = value.get("hooks") else {
        return Ok(());
    };
    let hooks = hooks
        .as_object()
        .ok_or_else(|| config_error("OBSERVER_CONFIG_SHAPE", "现有 hooks 字段不是对象。"))?;
    for (event, value) in hooks {
        if !mentions_owner(value, &spec.installation_id) {
            continue;
        }
        if !spec.events().contains(&event.as_str()) {
            return Err(config_error(
                "OBSERVER_CONFIG_CONFLICT",
                "此观察注册已被移到其他事件，请先核对配置。",
            ));
        }
        let mut count = 0;
        for group in value
            .as_array()
            .ok_or_else(|| config_error("OBSERVER_CONFIG_SHAPE", "Hook 事件不是列表。"))?
        {
            if !mentions_owner(group, &spec.installation_id) {
                continue;
            }
            if group
                .as_object()
                .is_none_or(|g| g.keys().any(|key| key != "hooks"))
            {
                return Err(config_error(
                    "OBSERVER_CONFIG_CONFLICT",
                    "Proof 匹配组的范围或字段已被修改，请先核对配置。",
                ));
            }
            for handler in handlers(group)? {
                if mentions_owner(handler, &spec.installation_id) {
                    if *handler != spec.handler(event, schema) {
                        return Err(config_error(
                            "OBSERVER_CONFIG_CONFLICT",
                            "Proof 观察条目已被修改，请先核对配置差异。",
                        ));
                    }
                    count += 1;
                }
            }
        }
        if count > 1 {
            return Err(config_error(
                "OBSERVER_CONFIG_CONFLICT",
                "此事件包含重复的 Proof 条目，请先核对配置。",
            ));
        }
    }
    Ok(())
}
fn remove_owned(
    document: &mut Document,
    ownership: &ConfigOwnership,
    clean_containers: bool,
) -> Result<()> {
    if document.value.get("hooks").is_none() {
        if mentions_owner(&document.value, &ownership.spec.installation_id) {
            return Err(config_error(
                "OBSERVER_CONFIG_CONFLICT",
                "配置的其他字段仍引用此观察注册，请先核对。",
            ));
        }
        return Ok(());
    }
    let spec = &ownership.spec;
    if !document.value["hooks"].is_object() {
        return Err(config_error(
            "OBSERVER_CONFIG_SHAPE",
            "现有 hooks 字段无法安全编辑。",
        ));
    }
    // Iterate backwards so earlier indexes retain their meaning after removal.
    let events: Vec<String> = document.value["hooks"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    for event in &events {
        let count = groups(&document.value, event)?.len();
        for group_index in (0..count).rev() {
            let group = &document.value["hooks"][event][group_index];
            let members = handlers(group)?;
            for member in members {
                if mentions_owner(member, &spec.installation_id)
                    && *member != spec.handler(event, ownership.schema_version)
                {
                    return Err(config_error(
                        "OBSERVER_CONFIG_CONFLICT",
                        "存在被修改的 Proof 条目，未生成删除方案。",
                    ));
                }
            }
            if *group == spec.group(event, ownership.schema_version) {
                document.remove_array_item(&["hooks", event], group_index)?;
            } else {
                let indexes: Vec<usize> = members
                    .iter()
                    .enumerate()
                    .filter_map(|(i, h)| {
                        (*h == spec.handler(event, ownership.schema_version)).then_some(i)
                    })
                    .collect();
                for index in indexes.into_iter().rev() {
                    document.remove_handler(event, group_index, index)?;
                }
            }
        }
    }
    if mentions_owner(&document.value, &spec.installation_id) {
        return Err(config_error(
            "OBSERVER_CONFIG_CONFLICT",
            "配置仍引用此观察注册，请先核对剩余引用。",
        ));
    }
    if clean_containers {
        for event in &ownership.created_events {
            if document.value["hooks"]
                .get(event)
                .is_some_and(|v| v.as_array().is_some_and(|a| a.is_empty()))
            {
                document.remove_property(&["hooks"], event)?;
            }
        }
        if ownership.created_hooks
            && document.value["hooks"]
                .as_object()
                .is_some_and(|m| m.is_empty())
        {
            document.remove_property(&[], "hooks")?;
        }
    }
    Ok(())
}
fn groups<'a>(value: &'a Value, event: &str) -> Result<&'a Vec<Value>> {
    value["hooks"][event].as_array().ok_or_else(|| {
        config_error(
            "OBSERVER_CONFIG_SHAPE",
            "现有 Hook 事件不是列表，未生成覆盖方案。",
        )
    })
}
fn handlers(value: &Value) -> Result<&Vec<Value>> {
    value["hooks"]
        .as_array()
        .ok_or_else(|| config_error("OBSERVER_CONFIG_SHAPE", "现有 Hook 匹配组无法安全编辑。"))
}
fn mentions_owner(value: &Value, id: &str) -> bool {
    match value {
        Value::String(s) => s.contains(id),
        Value::Array(a) => a.iter().any(|v| mentions_owner(v, id)),
        Value::Object(o) => o.values().any(|v| mentions_owner(v, id)),
        _ => false,
    }
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn decode(bytes: &[u8]) -> Result<String> {
    if bytes.len() > MAX_CONFIG {
        return Err(config_error(
            "OBSERVER_CONFIG_LIMIT",
            "配置文件超过 1 MiB，未生成覆盖方案。",
        ));
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| {
        config_error(
            "OBSERVER_CONFIG_ENCODING",
            "配置不是 UTF-8，未生成覆盖方案。",
        )
    })
}
fn config_error(code: &str, message: &str) -> Error {
    Error::new(code, message, "Existing Agent configuration is unchanged")
}

struct Document {
    text: String,
    value: Value,
    root: Node,
}
#[derive(Clone)]
struct Node {
    span: Range<usize>,
    kind: Kind,
}
#[derive(Clone)]
enum Kind {
    Object(Vec<(String, usize, Node)>),
    Array(Vec<Node>),
    Scalar,
}
impl Node {
    fn at(&self, path: &[&str]) -> Result<&Node> {
        let mut node = self;
        for key in path {
            let Kind::Object(properties) = &node.kind else {
                return Err(config_error("OBSERVER_CONFIG_SHAPE", "配置路径不是对象。"));
            };
            node = &properties
                .iter()
                .find(|(name, _, _)| name == key)
                .ok_or_else(|| config_error("OBSERVER_CONFIG_SHAPE", "配置字段不存在。"))?
                .2;
        }
        Ok(node)
    }
}
impl Document {
    fn parse(text: String) -> Result<Self> {
        if text.len() > MAX_CONFIG {
            return Err(config_error(
                "OBSERVER_CONFIG_LIMIT",
                "配置文件超过 1 MiB，未生成覆盖方案。",
            ));
        }
        let value = serde_json::from_str::<StrictValue>(&text)
            .map_err(|_| {
                config_error(
                    "OBSERVER_CONFIG_JSON",
                    "配置 JSON 无法解析或含重复键，原文件保持不变。",
                )
            })?
            .0;
        if !value.is_object() {
            return Err(config_error(
                "OBSERVER_CONFIG_SHAPE",
                "配置根节点必须是对象。",
            ));
        }
        let root = Parser {
            bytes: text.as_bytes(),
            cursor: 0,
        }
        .node()?;
        Ok(Self { text, value, root })
    }
    fn edit(&mut self, range: Range<usize>, replacement: &str) -> Result<()> {
        self.text.replace_range(range, replacement);
        *self = Self::parse(std::mem::take(&mut self.text))?;
        Ok(())
    }
    fn add_property(&mut self, path: &[&str], key: &str, value: &Value) -> Result<()> {
        let node = self.root.at(path)?;
        let Kind::Object(properties) = &node.kind else {
            return Err(config_error("OBSERVER_CONFIG_SHAPE", "配置路径不是对象。"));
        };
        let index = properties
            .last()
            .map_or(node.span.start + 1, |p| p.2.span.end);
        let text = format!(
            "{}{}:{}",
            if properties.is_empty() { "" } else { "," },
            serde_json::to_string(key)?,
            serde_json::to_string(value)?
        );
        self.edit(index..index, &text)
    }
    fn append(&mut self, path: &[&str], value: &Value) -> Result<()> {
        let node = self.root.at(path)?;
        let Kind::Array(elements) = &node.kind else {
            return Err(config_error("OBSERVER_CONFIG_SHAPE", "配置路径不是列表。"));
        };
        let index = elements.last().map_or(node.span.start + 1, |n| n.span.end);
        let text = format!(
            "{}{}",
            if elements.is_empty() { "" } else { "," },
            serde_json::to_string(value)?
        );
        self.edit(index..index, &text)
    }
    fn remove_property(&mut self, path: &[&str], key: &str) -> Result<()> {
        let node = self.root.at(path)?;
        let Kind::Object(properties) = &node.kind else {
            return Err(config_error("OBSERVER_CONFIG_SHAPE", "配置路径不是对象。"));
        };
        let Some(index) = properties.iter().position(|p| p.0 == key) else {
            return Ok(());
        };
        let ranges: Vec<Range<usize>> = properties.iter().map(|p| p.1..p.2.span.end).collect();
        self.edit(removal(&ranges, index), "")
    }
    fn remove_array_item(&mut self, path: &[&str], index: usize) -> Result<()> {
        let node = self.root.at(path)?;
        self.remove_at(node.clone(), index)
    }
    fn remove_handler(&mut self, event: &str, group: usize, index: usize) -> Result<()> {
        let node = self.root.at(&["hooks", event])?;
        let Kind::Array(groups) = &node.kind else {
            return Err(config_error("OBSERVER_CONFIG_SHAPE", "Hook 列表无法编辑。"));
        };
        let node = groups[group].at(&["hooks"])?;
        self.remove_at(node.clone(), index)
    }
    fn remove_at(&mut self, node: Node, index: usize) -> Result<()> {
        let Kind::Array(elements) = &node.kind else {
            return Err(config_error("OBSERVER_CONFIG_SHAPE", "Hook 列表无法编辑。"));
        };
        if index >= elements.len() {
            return Err(config_error("OBSERVER_CONFIG_SHAPE", "Hook 索引无效。"));
        }
        self.edit(
            removal(
                &elements.iter().map(|n| n.span.clone()).collect::<Vec<_>>(),
                index,
            ),
            "",
        )
    }
}
fn removal(ranges: &[Range<usize>], index: usize) -> Range<usize> {
    if index + 1 < ranges.len() {
        ranges[index].start..ranges[index + 1].start
    } else if index > 0 {
        ranges[index - 1].end..ranges[index].end
    } else {
        ranges[index].clone()
    }
}

// Syntax has already been validated. This cursor records byte spans only; it
// does not normalize values, comments, key ordering, or escaped user strings.
struct Parser<'a> {
    bytes: &'a [u8],
    cursor: usize,
}
impl Parser<'_> {
    fn whitespace(&mut self) {
        while self
            .bytes
            .get(self.cursor)
            .is_some_and(u8::is_ascii_whitespace)
        {
            self.cursor += 1;
        }
    }
    fn string(&mut self) -> Range<usize> {
        let start = self.cursor;
        self.cursor += 1;
        while self.bytes[self.cursor] != b'"' {
            if self.bytes[self.cursor] == b'\\' {
                self.cursor += 1;
            }
            self.cursor += 1;
        }
        self.cursor += 1;
        start..self.cursor
    }
    fn node(&mut self) -> Result<Node> {
        self.whitespace();
        let start = self.cursor;
        let kind = match self.bytes[self.cursor] {
            b'{' => {
                self.cursor += 1;
                self.whitespace();
                let mut properties = vec![];
                while self.bytes[self.cursor] != b'}' {
                    let range = self.string();
                    let key = serde_json::from_slice::<String>(&self.bytes[range.clone()])?;
                    self.whitespace();
                    self.cursor += 1;
                    let value = self.node()?;
                    properties.push((key, range.start, value));
                    self.whitespace();
                    if self.bytes[self.cursor] != b',' {
                        break;
                    }
                    self.cursor += 1;
                    self.whitespace();
                }
                self.cursor += 1;
                Kind::Object(properties)
            }
            b'[' => {
                self.cursor += 1;
                self.whitespace();
                let mut elements = vec![];
                while self.bytes[self.cursor] != b']' {
                    elements.push(self.node()?);
                    self.whitespace();
                    if self.bytes[self.cursor] != b',' {
                        break;
                    }
                    self.cursor += 1;
                    self.whitespace();
                }
                self.cursor += 1;
                Kind::Array(elements)
            }
            b'"' => {
                self.string();
                Kind::Scalar
            }
            _ => {
                while self
                    .bytes
                    .get(self.cursor)
                    .is_some_and(|b| !b.is_ascii_whitespace() && !b",]}".contains(b))
                {
                    self.cursor += 1;
                }
                Kind::Scalar
            }
        };
        Ok(Node {
            span: start..self.cursor,
            kind,
        })
    }
}

// serde_json::Value normally accepts duplicate object keys. Reject ambiguity
// rather than accidentally changing which permissions/hook definition wins.
struct StrictValue(Value);
impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = StrictValue;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("unambiguous JSON")
            }
            fn visit_bool<E: serde::de::Error>(
                self,
                v: bool,
            ) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(Value::Number(
                    serde_json::Number::from_f64(v)
                        .ok_or_else(|| E::custom("non-finite number"))?,
                )))
            }
            fn visit_str<E: serde::de::Error>(
                self,
                v: &str,
            ) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(Value::Null))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = vec![];
                while let Some(value) = sequence.next_element::<StrictValue>()? {
                    values.push(value.0);
                }
                Ok(StrictValue(values.into()))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = serde_json::Map::new();
                while let Some((key, value)) = map.next_entry::<String, StrictValue>()? {
                    if values.insert(key, value.0).is_some() {
                        return Err(serde::de::Error::custom("duplicate key"));
                    }
                }
                Ok(StrictValue(values.into()))
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}
