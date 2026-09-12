use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_INPUT: usize = 2 * 1024 * 1024;
pub const MAX_HEADER: usize = 1024;
pub const BRIDGE_DEADLINE_MS: u64 = 50;

pub use proof_core::ObserverAgent as Agent;

/// Stored only in the private application data directory. The token never goes
/// into argv, hook stdout/stderr, repository files or diagnostic export.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Registration {
    pub schema_version: u32,
    pub installation_id: String,
    pub agent: Agent,
    pub agent_version: String,
    pub socket_path: String,
    pub token: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Header {
    pub schema_version: u32,
    pub installation_id: String,
    pub agent: Agent,
    pub agent_version: String,
    pub token: String,
    pub payload_bytes: usize,
    pub bridge_started_at: u64,
    pub fault: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportError {
    Configuration,
    Permission,
    Unavailable,
    Deadline,
    InputLimit,
    Io,
    Protocol,
}
pub type Result<T> = std::result::Result<T, TransportError>;

pub fn encode_header(
    registration: &Registration,
    payload_bytes: usize,
    started_at: u64,
    fault: Option<&str>,
) -> Result<Vec<u8>> {
    if registration.schema_version != SCHEMA_VERSION
        || uuid::Uuid::parse_str(&registration.installation_id).is_err()
        || registration.token.len() != 64
        || !registration.token.bytes().all(|c| c.is_ascii_hexdigit())
        || registration.agent_version.len() > 64
        || payload_bytes > MAX_INPUT
    {
        return Err(TransportError::Configuration);
    }
    let header = Header {
        schema_version: SCHEMA_VERSION,
        installation_id: registration.installation_id.clone(),
        agent: registration.agent,
        agent_version: registration.agent_version.clone(),
        token: registration.token.clone(),
        payload_bytes,
        bridge_started_at: started_at,
        fault: fault.map(String::from),
    };
    let bytes = serde_json::to_vec(&header).map_err(|_| TransportError::Protocol)?;
    if bytes.len() > MAX_HEADER {
        return Err(TransportError::Protocol);
    }
    let mut result = (bytes.len() as u32).to_be_bytes().to_vec();
    result.extend(bytes);
    Ok(result)
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
