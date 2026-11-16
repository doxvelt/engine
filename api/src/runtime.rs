//! Untrusted model streams produce candidate artifacts, never committed turns.
//! Transport and credential ownership remain outside this domain boundary.
use crate::{contracts::safe_identifier, identity::sha256};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const MAX_TOKENS: u64 = 9_007_199_254_740_991;
const MAX_TEXT: usize = 1_000_000;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    Stop,
    Length,
    ToolUse,
    Error,
    Aborted,
    Other,
}
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Observation {
    input: Option<u64>,
    output: Option<u64>,
    total: Option<u64>,
    pub stop_reason: Option<StopReason>,
}
impl Observation {
    fn merge_usage(&mut self, update: Option<&Value>) -> std::result::Result<(), ()> {
        let Some(update) = update else {
            return Ok(());
        };
        let source = update.as_object().ok_or(())?;
        let mut candidate = self.clone();
        for (key, target) in [
            ("inputTokens", &mut candidate.input),
            ("outputTokens", &mut candidate.output),
            ("totalTokens", &mut candidate.total),
        ] {
            if let Some(raw) = source.get(key) {
                let number = raw
                    .as_f64()
                    .filter(|n| *n >= 0.0 && *n <= MAX_TOKENS as f64 && n.fract() == 0.0)
                    .ok_or(())? as u64;
                if target.is_some_and(|prior| prior != number) {
                    return Err(());
                }
                *target = Some(number);
            }
        }
        if let (Some(input), Some(output)) = (candidate.input, candidate.output) {
            let sum = input
                .checked_add(output)
                .filter(|n| *n <= MAX_TOKENS)
                .ok_or(())?;
            if candidate.total.is_some_and(|total| total != sum) {
                return Err(());
            }
        }
        *self = candidate;
        Ok(())
    }
    fn observe_stop(&mut self, stop: Option<&Value>) -> std::result::Result<(), ()> {
        if let Some(stop) = stop.filter(|v| !v.is_null()) {
            self.stop_reason = Some(serde_json::from_value(stop.clone()).map_err(|_| ())?);
        }
        Ok(())
    }
    fn normalized_usage(&self) -> std::result::Result<Usage, ()> {
        let input = self.input.unwrap_or(0);
        let output = self.output.unwrap_or(0);
        let sum = input
            .checked_add(output)
            .filter(|n| *n <= MAX_TOKENS)
            .ok_or(())?;
        if self.total.is_some_and(|total| total != sum) {
            return Err(());
        }
        Ok(Usage {
            input_tokens: input,
            output_tokens: output,
            total_tokens: sum,
        })
    }
    /// Failure provenance only retains verified input/output counts. A rejected
    /// fragment cannot replace previously observed usage or persist raw errors.
    pub fn safe_usage(&self) -> Usage {
        let mut verified = self.clone();
        verified.total = None;
        verified.normalized_usage().unwrap_or_default()
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCode {
    RuntimeFailure,
    InvalidStream,
    OutputContract,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamFailure {
    pub code: FailureCode,
    pub observation: Observation,
}
impl StreamFailure {
    pub fn message(&self) -> &'static str {
        match self.code {
            FailureCode::RuntimeFailure => "Runtime generation failed.",
            FailureCode::InvalidStream => "Runtime output was invalid.",
            FailureCode::OutputContract => {
                "Runtime output did not satisfy the required JSON performance and audience contract."
            }
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamOutcome {
    Completed {
        text: String,
        observation: Observation,
    },
    Failed {
        observation: Observation,
    },
}
#[derive(Debug, Default)]
pub struct RuntimeStream {
    observation: Observation,
    terminal: Option<Option<String>>,
    deltas: String,
    delta_length: usize,
    event_count: usize,
}
impl RuntimeStream {
    pub fn observation(&self) -> Observation {
        self.observation.clone()
    }
    fn invalid(&self) -> StreamFailure {
        StreamFailure {
            code: FailureCode::InvalidStream,
            observation: self.observation.clone(),
        }
    }
    pub fn push(&mut self, event: &Value) -> std::result::Result<(), StreamFailure> {
        self.event_count += 1;
        if self.event_count > 10_000 || self.terminal.is_some() || !event.is_object() {
            return Err(self.invalid());
        }
        match event["type"].as_str() {
            Some("text_delta") => {
                let text = event["text"].as_str().ok_or_else(|| self.invalid())?;
                let length = text.encode_utf16().count();
                if self.delta_length + length > MAX_TEXT {
                    return Err(self.invalid());
                }
                self.delta_length += length;
                self.deltas.push_str(text);
            }
            Some("usage") => {
                self.observation
                    .merge_usage(event.get("usage"))
                    .map_err(|_| self.invalid())?;
            }
            Some("completed") => {
                let text = event["text"]
                    .as_str()
                    .filter(|t| t.encode_utf16().count() <= MAX_TEXT)
                    .ok_or_else(|| self.invalid())?;
                self.observation
                    .merge_usage(event.get("usage"))
                    .map_err(|_| self.invalid())?;
                self.observation
                    .observe_stop(event.get("stopReason"))
                    .map_err(|_| self.invalid())?;
                self.terminal = Some(Some(text.to_owned()));
            }
            Some("failed") => {
                self.observation
                    .merge_usage(event.get("usage"))
                    .map_err(|_| self.invalid())?;
                self.observation
                    .observe_stop(event.get("stopReason"))
                    .map_err(|_| self.invalid())?;
                self.terminal = Some(None);
            }
            _ => return Err(self.invalid()),
        }
        Ok(())
    }
    pub fn abort(mut self) -> StreamFailure {
        self.observation.stop_reason = Some(StopReason::Aborted);
        StreamFailure {
            code: FailureCode::RuntimeFailure,
            observation: self.observation,
        }
    }
    pub fn transport_failure(self) -> StreamFailure {
        StreamFailure {
            code: FailureCode::RuntimeFailure,
            observation: self.observation,
        }
    }
    pub fn finish(self) -> std::result::Result<StreamOutcome, StreamFailure> {
        if self.terminal.is_none() || self.observation.normalized_usage().is_err() {
            return Err(self.invalid());
        }
        if self.terminal == Some(None)
            || matches!(
                self.observation.stop_reason,
                Some(StopReason::Aborted | StopReason::Error | StopReason::ToolUse)
            )
        {
            return Ok(StreamOutcome::Failed {
                observation: self.observation,
            });
        }
        let text = self.terminal.as_ref().unwrap().as_ref().unwrap();
        if text.is_empty() || (!self.deltas.is_empty() && &self.deltas != text) {
            return Err(self.invalid());
        }
        Ok(StreamOutcome::Completed {
            text: text.clone(),
            observation: self.observation,
        })
    }
}

/// Canonical context retains simulation meaning while stripping adapter-local
/// paths, timestamps and the duplicate rendered prompt before hashing.
pub fn canonical_context(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(canonical_context).collect()),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .filter(|(key, _)| {
                    ![
                        "sourceRoot",
                        "path",
                        "folder",
                        "createdAt",
                        "updatedAt",
                        "promptPreview",
                    ]
                    .contains(&key.as_str())
                })
                .map(|(key, v)| (key.clone(), canonical_context(v)))
                .collect(),
        ),
        _ => value.clone(),
    }
}
pub fn artifact_digest(text: &str, audience: Option<&[String]>) -> String {
    sha256(
        &audience
            .map(|ids| serde_json::to_string(&json!({"text":text,"proposedAudience":ids})).unwrap())
            .unwrap_or_else(|| text.to_owned()),
    )
}
pub fn provenance(
    identity: &Value,
    profile: &Value,
    observation: &Observation,
    completed: bool,
) -> Value {
    let safe = |value: &Value| value.as_str().and_then(|id| safe_identifier(id, "").ok());
    json!({"adapter":{"id":safe(&identity["id"]).unwrap_or_else(|| "unknown".into()),"version":safe(&identity["version"]).unwrap_or_else(|| "unknown".into())},
        "runtimeProfile":{"id":safe(&profile["id"]).unwrap_or_else(|| "unknown".into()),"version":safe(&profile["version"]).unwrap_or_else(|| "unknown".into())},
        "providerId":safe(&identity["providerId"]),"modelId":safe(&identity["modelId"]),"usage":observation.safe_usage(),"stopReason":observation.stop_reason,"terminalStatus":if completed {"completed"} else {"failed"}})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn usage_fragments_are_write_once_and_terminal_wording_must_match() {
        let mut stream = RuntimeStream::default();
        stream
            .push(&json!({"type":"usage","usage":{"inputTokens":3}}))
            .unwrap();
        stream
            .push(&json!({"type":"text_delta","text":"Word"}))
            .unwrap();
        stream
            .push(&json!({"type":"text_delta","text":"s 🦊"}))
            .unwrap();
        stream.push(&json!({"type":"completed","text":"Words 🦊","usage":{"inputTokens":3.0,"outputTokens":2,"totalTokens":5},"stopReason":"stop"})).unwrap();
        let StreamOutcome::Completed { text, observation } = stream.finish().unwrap() else {
            panic!("Unexpected failed completion")
        };
        assert_eq!(text, "Words 🦊");
        assert_eq!(
            observation.safe_usage(),
            Usage {
                input_tokens: 3,
                output_tokens: 2,
                total_tokens: 5
            }
        );
        let mut stream = RuntimeStream::default();
        stream
            .push(&json!({"type":"usage","usage":{"inputTokens":3}}))
            .unwrap();
        let failure = stream
            .push(&json!({"type":"usage","usage":{"inputTokens":4,"outputTokens":100}}))
            .unwrap_err();
        assert_eq!(
            failure.observation.safe_usage(),
            Usage {
                input_tokens: 3,
                output_tokens: 0,
                total_tokens: 3
            }
        );
        let mut stream = RuntimeStream::default();
        stream
            .push(&json!({"type":"text_delta","text":"partial"}))
            .unwrap();
        stream
            .push(&json!({"type":"completed","text":"different"}))
            .unwrap();
        assert_eq!(
            stream.finish().unwrap_err().code,
            FailureCode::InvalidStream
        );
    }
    #[test]
    fn malformed_streams_tools_and_unsafe_usage_never_create_a_candidate() {
        for events in [
            vec![],
            vec![json!({"type":"tool_requested","name":"shell"})],
            vec![json!({"type":"completed","text":"x","usage":{"totalTokens":1}})],
            vec![
                json!({"type":"completed","text":"x"}),
                json!({"type":"usage","usage":{}}),
            ],
            vec![json!({"type":"usage","usage":{"inputTokens":9_007_199_254_740_992_u64}})],
            vec![
                json!({"type":"completed","text":"x","usage":{"inputTokens":1,"outputTokens":2,"totalTokens":4}}),
            ],
            vec![json!({"type":"usage","usage":null})],
        ] {
            let mut stream = RuntimeStream::default();
            let mut invalid = false;
            for event in events {
                if stream.push(&event).is_err() {
                    invalid = true;
                    break;
                }
            }
            assert!(invalid || stream.finish().is_err());
        }
        let mut stream = RuntimeStream::default();
        stream
            .push(&json!({"type":"completed","text":"Do not accept","stopReason":"tool_use"}))
            .unwrap();
        assert!(matches!(
            stream.finish().unwrap(),
            StreamOutcome::Failed { .. }
        ));
    }
    #[test]
    fn cancellation_and_failure_provenance_exclude_credentials_and_raw_provider_errors() {
        let mut stream = RuntimeStream::default();
        stream
            .push(&json!({"type":"usage","usage":{"inputTokens":2}}))
            .unwrap();
        let failed = stream.abort();
        let identity = json!({"id":"dsh","version":"v1","providerId":"sk-live-secret","modelId":"https://host/model?secret=1"});
        let record = provenance(
            &identity,
            &json!({"id":"local-character","version":"v1"}),
            &failed.observation,
            false,
        );
        assert_eq!(record["providerId"], Value::Null);
        assert_eq!(record["modelId"], Value::Null);
        assert_eq!(record["usage"]["totalTokens"], 2);
        assert_eq!(record["stopReason"], "aborted");
        assert_eq!(failed.message(), "Runtime generation failed.");
    }
}
