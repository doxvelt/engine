//! Bounds shared by manual corrections and runtime artifacts.
use crate::error::{EngineError, Result};
use regex::Regex;
use std::sync::LazyLock;
pub fn safe_identifier(value: &str, label: &str) -> Result<String> {
    static ID: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^@?[A-Za-z0-9][A-Za-z0-9._/+@-]*$").unwrap());
    static CREDENTIAL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^(?:sk[_-](?:(?:proj|live)[_-])?|pk_|rk_|gh[pous]_|xox[baprs]-|AKIA|AIza|ya29\.)|^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$").unwrap()
    });
    let normalized = value.trim();
    if normalized.is_empty()
        || normalized.encode_utf16().count() > 160
        || !ID.is_match(normalized)
        || normalized
            .split('/')
            .any(|part| part.is_empty() || [".", ".."].contains(&part) || CREDENTIAL.is_match(part))
    {
        return Err(EngineError::invalid(format!(
            "{label} is invalid or credential-shaped."
        )));
    }
    Ok(normalized.into())
}
pub fn runtime_text(value: &str, label: &str) -> Result<()> {
    if value.trim().is_empty() || value.encode_utf16().count() > 1_000_000 {
        Err(EngineError::invalid(format!(
            "{label} is empty or exceeds the runtime limit."
        )))
    } else {
        Ok(())
    }
}
