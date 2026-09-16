//! One capability catalog for active analysis and passive observation.
//! Their processes, consent and storage remain separate; availability does not.
use crate::{
    AgentKind, AgentProvider, ClaudeCodeProvider, CodewizProvider, CodexProvider, ObserverAgent,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookIntegration {
    CodexCommands,
    ClaudeCommands,
    CodewizPlugin,
}

pub struct AgentAdapter {
    pub kind: AgentKind,
    pub observer: ObserverAgent,
    pub name: &'static str,
    pub executable: &'static str,
    pub installed_only: bool,
    pub hooks: HookIntegration,
    provider: fn() -> Box<dyn AgentProvider>,
}

pub static AGENT_ADAPTERS: &[AgentAdapter] = &[
    AgentAdapter {
        kind: AgentKind::Codex,
        observer: ObserverAgent::Codex,
        name: "Codex",
        executable: "codex",
        installed_only: false,
        hooks: HookIntegration::CodexCommands,
        provider: || Box::new(CodexProvider),
    },
    AgentAdapter {
        kind: AgentKind::ClaudeCode,
        observer: ObserverAgent::Claude,
        name: "Claude Code",
        executable: "claude",
        installed_only: false,
        hooks: HookIntegration::ClaudeCommands,
        provider: || Box::new(ClaudeCodeProvider),
    },
    AgentAdapter {
        kind: AgentKind::Codewiz,
        observer: ObserverAgent::Codewiz,
        name: "Codewiz",
        executable: "codewiz",
        installed_only: true,
        hooks: HookIntegration::CodewizPlugin,
        provider: || Box::new(CodewizProvider),
    },
];

impl AgentAdapter {
    pub fn provider(&self) -> Box<dyn AgentProvider> {
        (self.provider)()
    }
    pub fn hook_installation_available(&self) -> bool {
        cfg!(target_os = "macos") && self.hooks != HookIntegration::ClaudeCommands
    }
    pub fn hook_unavailable_reason(&self) -> Option<&'static str> {
        if !cfg!(target_os = "macos") {
            Some("此平台暂不支持安装 Agent Hook。")
        } else if self.hooks == HookIntegration::ClaudeCommands {
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
