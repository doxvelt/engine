use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    Invalid,
    NotFound,
    Conflict,
    CommandConflict,
    MemoryJobConflict,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EngineError {
    pub code: ErrorCode,
    pub message: String,
}
impl EngineError {
    pub fn command_conflict(id: &str) -> Self {
        Self {
            code: ErrorCode::CommandConflict,
            message: format!("Command identity {id} was already used with different input."),
        }
    }
    pub fn branch_conflict(expected: &str, actual: &str) -> Self {
        Self {
            code: ErrorCode::Conflict,
            message: format!("Branch head conflict: expected {expected}, actual {actual}."),
        }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::Invalid,
            message: message.into(),
        }
    }
}
impl fmt::Display for EngineError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}
impl std::error::Error for EngineError {}
pub type Result<T> = std::result::Result<T, EngineError>;
