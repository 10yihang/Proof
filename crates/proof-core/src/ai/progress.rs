use serde::Serialize;
use serde_json::Value;
use std::path::{Component, Path};

/// Public activity only: never reasoning, prompts, tool output, or raw commands.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProgress {
    pub phase: &'static str,
    pub path: Option<String>,
    pub completed: Option<usize>,
    pub total: Option<usize>,
}
impl AiProgress {
    pub(super) fn phase(phase: &'static str) -> Self {
        Self {
            phase,
            path: None,
            completed: None,
            total: None,
        }
    }
    pub(super) fn capture(path: &str, completed: usize, total: usize) -> Self {
        Self {
            phase: "preparing",
            path: Some(path.into()),
            completed: Some(completed),
            total: Some(total),
        }
    }
}

pub(super) struct ActivityStream<'a> {
    pending: Vec<u8>,
    oversized: bool,
    paths: &'a [String],
    project: Option<&'a Path>,
    emit: &'a dyn Fn(AiProgress),
}
impl<'a> ActivityStream<'a> {
    pub fn new(paths: &'a [String], emit: &'a dyn Fn(AiProgress)) -> Self {
        Self {
            pending: Vec::new(),
            oversized: false,
            paths,
            project: None,
            emit,
        }
    }
    pub fn in_project(
        paths: &'a [String],
        project: &'a Path,
        emit: &'a dyn Fn(AiProgress),
    ) -> Self {
        Self {
            project: Some(project),
            ..Self::new(paths, emit)
        }
    }
    pub fn feed(&mut self, bytes: &[u8]) {
        for part in bytes.split_inclusive(|byte| *byte == b'\n') {
            if self.pending.len() + part.len() > 2 * 1024 * 1024 {
                self.pending.clear();
                self.oversized = true;
            }
            if !self.oversized {
                self.pending.extend_from_slice(part);
            }
            if part.last() == Some(&b'\n') {
                if !self.oversized {
                    if let Ok(Some(event)) = super::events::parse_line(&self.pending) {
                        self.event(&event);
                    }
                }
                self.pending.clear();
                self.oversized = false;
            }
        }
    }
    fn tool(&self, name: &str, input: &Value) {
        let command = input["command"].as_str().unwrap_or_default();
        let phase = match name {
            "Read" | "read" => "reading",
            "Grep" | "Glob" | "grep" | "glob" | "list" => "searching",
            _ if command.contains("rg ")
                || command.contains("grep ")
                || command.contains("find ") =>
            {
                "searching"
            }
            _ if command.contains("git ") => "git",
            _ => "tool",
        };
        let file = input["file_path"]
            .as_str()
            .or_else(|| input["filePath"].as_str())
            .or_else(|| input["path"].as_str());
        let reference = file.unwrap_or(command);
        let path = self
            .paths
            .iter()
            .filter(|path| reference.contains(path.as_str()))
            .max_by_key(|path| path.len())
            .cloned()
            .or_else(|| {
                let root = self.project?;
                let file = file.filter(|file| {
                    !file.is_empty() && file.len() <= 4096 && !file.chars().any(char::is_control)
                })?;
                let path = Path::new(file);
                let relative = if path.is_absolute() {
                    path.strip_prefix(root).ok()?
                } else {
                    path
                };
                relative
                    .components()
                    .all(|part| matches!(part, Component::Normal(_)))
                    .then(|| relative.to_string_lossy().into_owned())
            });
        (self.emit)(AiProgress {
            path,
            ..AiProgress::phase(phase)
        });
    }
    fn event(&self, event: &Value) {
        match event["type"].as_str() {
            Some("thread.started" | "turn.started" | "system" | "step_start") => {
                (self.emit)(AiProgress::phase("analyzing"))
            }
            Some("tool_use") => {
                let part = &event["part"];
                if part["state"]["status"] == "error" {
                    (self.emit)(AiProgress::phase("tool_failed"));
                } else {
                    self.tool(
                        part["tool"].as_str().unwrap_or_default(),
                        &part["state"]["input"],
                    );
                }
            }
            Some("item.started") if event["item"]["type"] == "command_execution" => {
                self.tool("Bash", &event["item"])
            }
            Some("item.completed") if event["item"]["type"] == "command_execution" => {
                (self.emit)(AiProgress::phase(
                    if event["item"]["exit_code"].as_i64().is_some_and(|n| n != 0) {
                        "tool_failed"
                    } else {
                        "analyzing"
                    },
                ));
            }
            Some("assistant") => {
                if let Some(content) = event["message"]["content"].as_array() {
                    for block in content {
                        if block["type"] == "tool_use" {
                            self.tool(block["name"].as_str().unwrap_or_default(), &block["input"]);
                        }
                    }
                }
            }
            Some("user")
                if event["message"]["content"]
                    .as_array()
                    .is_some_and(|blocks| blocks.iter().any(|b| b["type"] == "tool_result")) =>
            {
                (self.emit)(AiProgress::phase("analyzing"))
            }
            _ => (),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    #[test]
    fn codewiz_activity_uses_the_same_framing_as_final_results() {
        let events = RefCell::new(Vec::new());
        let paths = vec!["src/auth.rs".into()];
        let emit = |event| events.borrow_mut().push(event);
        let mut stream = ActivityStream::new(&paths, &emit);
        let text = b"\xef\xbb\xbf[INFO] private-token\r\n\x1b[36m{\"type\":\"step_start\"}\x1b[0m\r\n \t\r\n[INFO] {\"type\":\"step_start\"}\n\x1b[2K{\"type\":\"tool_use\",\"part\":{\"tool\":\"read\",\"state\":{\"status\":\"completed\",\"input\":{\"filePath\":\"/repo/src/auth.rs\"},\"output\":\"private-token\"}}}\x1b[0m\r\n";
        for chunk in text.chunks(5) {
            stream.feed(chunk);
        }
        let events = events.borrow();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].phase, "analyzing");
        assert_eq!(events[1].phase, "reading");
        assert_eq!(events[1].path.as_deref(), Some("src/auth.rs"));
        assert!(!serde_json::to_string(&*events)
            .unwrap()
            .contains("private-token"));
    }

    #[test]
    fn project_context_progress_includes_related_files_but_not_outside_paths_or_raw_commands() {
        let events = RefCell::new(Vec::new());
        let emit = |event| events.borrow_mut().push(event);
        let stream = ActivityStream::in_project(&[], Path::new("/repo"), &emit);
        stream.tool(
            "read",
            &serde_json::json!({"filePath":"/repo/docs/contract.md"}),
        );
        stream.tool(
            "read",
            &serde_json::json!({"filePath":"/personal/private.txt"}),
        );
        stream.tool("read", &serde_json::json!({"path":"../private.txt"}));
        stream.tool("bash", &serde_json::json!({"command":"rg private-query ."}));
        let events = events.borrow();
        assert_eq!(events[0].path.as_deref(), Some("docs/contract.md"));
        assert!(events[1..].iter().all(|event| event.path.is_none()));
        assert!(!serde_json::to_string(&*events).unwrap().contains("private"));
    }
    #[test]
    fn fragmented_events_expose_actions_but_never_reasoning_or_command_secrets() {
        let events = RefCell::new(Vec::new());
        let paths = vec!["src/auth.rs".into()];
        let emit = |event| events.borrow_mut().push(event);
        let mut stream = ActivityStream::new(&paths, &emit);
        for bytes in b"{\"type\":\"item.started\",\"item\":{\"type\":\"command_execution\",\"command\":\"rg secret-token src/auth.rs\"}}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"reasoning\",\"text\":\"private reasoning\"}}\n{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Read\",\"input\":{\"file_path\":\"/snapshot/src/auth.rs\"}}]}}\n".chunks(7) { stream.feed(bytes); }
        let events = events.borrow();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].phase, "searching");
        assert_eq!(events[1].phase, "reading");
        assert_eq!(events[1].path.as_deref(), Some("src/auth.rs"));
        let json = serde_json::to_string(&*events).unwrap();
        assert!(!json.contains("secret-token") && !json.contains("private reasoning"));
    }
}
