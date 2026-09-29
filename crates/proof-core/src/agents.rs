//! One capability catalog for active analysis and passive observation.
//! Their processes, consent and storage remain separate; availability does not.
use crate::{
    AgentKind, AgentProvider, ClaudeCodeProvider, CodewizProvider, CodexProvider, OcrProvider,
    ObserverAgent,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookIntegration {
    CodexCommands,
    ClaudeCommands,
    CodewizPlugin,
}

pub struct AgentAdapter {
    pub kind: AgentKind,
    /// Passive observation support. Providers without session observation
    /// (currently OCR) never appear in the Observer settings.
    pub observer: Option<ObserverAgent>,
    pub name: &'static str,
    pub executable: &'static str,
    pub installed_only: bool,
    pub hooks: Option<HookIntegration>,
    provider: fn() -> Box<dyn AgentProvider>,
}

pub static AGENT_ADAPTERS: &[AgentAdapter] = &[
    AgentAdapter {
        kind: AgentKind::Codex,
        observer: Some(ObserverAgent::Codex),
        name: "Codex",
        executable: "codex",
        installed_only: false,
        hooks: Some(HookIntegration::CodexCommands),
        provider: || Box::new(CodexProvider),
    },
    AgentAdapter {
        kind: AgentKind::ClaudeCode,
        observer: Some(ObserverAgent::Claude),
        name: "Claude Code",
        executable: "claude",
        installed_only: false,
        hooks: Some(HookIntegration::ClaudeCommands),
        provider: || Box::new(ClaudeCodeProvider),
    },
    AgentAdapter {
        kind: AgentKind::Codewiz,
        observer: Some(ObserverAgent::Codewiz),
        name: "Codewiz",
        executable: "codewiz",
        installed_only: true,
        hooks: Some(HookIntegration::CodewizPlugin),
        provider: || Box::new(CodewizProvider),
    },
    AgentAdapter {
        kind: AgentKind::Ocr,
        observer: None,
        name: "OpenCodeReview",
        executable: "ocr",
        installed_only: false,
        hooks: None,
        provider: || Box::new(OcrProvider),
    },
];

impl AgentAdapter {
    pub fn provider(&self) -> Box<dyn AgentProvider> {
        (self.provider)()
    }
    pub fn hook_installation_available(&self) -> bool {
        cfg!(target_os = "macos") && self.hooks.is_some_and(|hooks| hooks != HookIntegration::ClaudeCommands)
    }
    pub fn hook_unavailable_reason(&self) -> Option<&'static str> {
        if self.hooks.is_none() {
            Some("此 Agent 不支持会话观察。")
        } else if !cfg!(target_os = "macos") {
            Some("此平台暂不支持安装 Agent Hook。")
        } else if self.hooks == Some(HookIntegration::ClaudeCommands) {
            Some("Claude Code Hook 暂未开放安装。")
        } else {
            None
        }
    }
}

impl AgentKind {
    pub fn adapter(self) -> &'static AgentAdapter {
        &AGENT_ADAPTERS[match self {
            Self::Codex => 0,
            Self::ClaudeCode => 1,
            Self::Codewiz => 2,
            Self::Ocr => 3,
        }]
    }
}
impl ObserverAgent {
    pub fn adapter(self) -> &'static AgentAdapter {
        match self {
            Self::Codex => AgentKind::Codex,
            Self::Claude => AgentKind::ClaudeCode,
            Self::Codewiz => AgentKind::Codewiz,
        }
        .adapter()
    }
}
