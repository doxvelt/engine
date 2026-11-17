//! One credential-free Reverie protocol-1 process per character and operation.
use crate::{Bridge, HostError};
use doxvelt_engine::episode_memory::{MemoryConfiguration, Source, named_reflection};
use serde_json::{Value, json};
use std::{collections::HashMap, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    task::{AbortHandle, JoinSet},
};

fn failure(message: &str) -> HostError {
    HostError {
        status: 503,
        message: message.into(),
    }
}
pub struct Reflection {
    pub bridge: Bridge,
    pub source: Source,
    pub revision: String,
    pub model_key: String,
    pub prior: Vec<Value>,
}
pub struct Session {
    child: Child,
    input: Option<ChildStdin>,
    lines: Lines<BufReader<ChildStdout>>,
    character: String,
    next: u64,
    reflection: Option<Reflection>,
    tasks: JoinSet<(String, std::result::Result<Value, String>)>,
    callbacks: HashMap<String, AbortHandle>,
    sources: HashMap<String, Value>,
}
impl Session {
    pub async fn open(
        configuration: &MemoryConfiguration,
        database: &str,
        character: &str,
        reflection: Option<Reflection>,
    ) -> Result<Self, HostError> {
        let mut command = Command::new(&configuration.executable);
        command.args(["--stdio", "--character", character, "--database", database]);
        command.env_clear();
        for (key, value) in std::env::vars_os() {
            if [
                "path",
                "systemroot",
                "windir",
                "temp",
                "tmp",
                "lang",
                "lc_all",
                "tz",
            ]
            .contains(&key.to_string_lossy().to_lowercase().as_str())
            {
                command.env(key, value);
            }
        }
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| failure("Could not start Reverie."))?;
        let input = child.stdin.take().unwrap();
        let lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut session = Self {
            child,
            input: Some(input),
            lines,
            character: character.into(),
            next: 0,
            reflection,
            tasks: JoinSet::new(),
            callbacks: HashMap::new(),
            sources: HashMap::new(),
        };
        let hello = session.request("ping", json!({})).await?;
        if hello["protocol"] != 1 || hello["characterId"] != character {
            return Err(failure("Doxvelt requires Reverie native protocol 1."));
        }
        Ok(session)
    }
    /// Transfer operations may read only the source projections supplied by
    /// the host for this character. They never receive model authorization.
    pub fn supply_source(&mut self, episode: &str, source: Value) {
        self.sources.insert(episode.into(), source);
    }
    async fn send(&mut self, value: &Value) -> Result<(), HostError> {
        let mut text = serde_json::to_vec(value).unwrap();
        text.push(b'\n');
        self.input
            .as_mut()
            .ok_or_else(|| failure("Reverie connection closed."))?
            .write_all(&text)
            .await
            .map_err(|_| failure("Reverie connection closed."))?;
        self.input
            .as_mut()
            .ok_or_else(|| failure("Reverie connection closed."))?
            .flush()
            .await
            .map_err(|_| failure("Reverie connection closed."))
    }
    fn callback(&mut self, envelope: Value) -> Result<(), HostError> {
        let id = envelope["callId"].as_str().unwrap().to_owned();
        if self.callbacks.contains_key(&id) {
            return Err(failure("Reverie repeated an active callback identity."));
        }
        let params = envelope["params"].clone();
        let method = envelope["method"].as_str().unwrap_or_default();
        let valid = params.is_object()
            && params["characterId"] == self.character
            && params["episodeId"].is_string();
        let authorized = self
            .reflection
            .as_ref()
            .filter(|r| valid && params["episodeId"] == r.revision);
        let task_id = id.clone();
        let supplied = valid
            .then(|| {
                params["episodeId"]
                    .as_str()
                    .and_then(|id| self.sources.get(id))
            })
            .flatten()
            .cloned();
        let handle = match (method, authorized) {
            ("source.read", _) if supplied.is_some() => {
                let source = supplied.unwrap();
                self.tasks.spawn(async move { (task_id, Ok(source)) })
            }
            ("source.read", Some(reflection)) => {
                let result = reflection.source.observation.clone();
                self.tasks.spawn(async move { (task_id, Ok(result)) })
            }
            ("model.reflect", Some(reflection))
                if params["modelKey"] == reflection.model_key
                    && params["request"]["system"].is_string()
                    && params["request"]["maxTokens"].is_number() =>
            {
                let request =
                    named_reflection(&params["request"], &reflection.source, &reflection.prior);
                let bridge = reflection.bridge.clone();
                let model_key = reflection.model_key.clone();
                self.tasks.spawn(async move {
                    let result = match request {
                        Ok(request) => bridge
                            .call(
                                "memory.reflect",
                                json!({"request":request,"modelKey":model_key}),
                            )
                            .await
                            .map_err(|_| "Memory reflection model failed.".into())
                            .and_then(|value| {
                                if value.is_string() {
                                    Ok(value)
                                } else {
                                    Err("Memory reflection returned invalid text.".into())
                                }
                            }),
                        Err(error) => Err(error.message),
                    };
                    (task_id, result)
                })
            }
            _ => self.tasks.spawn(async move {
                (
                    task_id,
                    Err("This Reverie operation cannot service that source or callback.".into()),
                )
            }),
        };
        self.callbacks.insert(id, handle);
        Ok(())
    }
    pub async fn request(&mut self, method: &str, params: Value) -> Result<Value, HostError> {
        self.next += 1;
        let id = self.next;
        self.send(&json!({"id":id,"method":method,"params":params}))
            .await?;
        loop {
            tokio::select! {
                completion = self.tasks.join_next(), if !self.tasks.is_empty() => {
                    if let Some(Ok((call, result))) = completion {
                        // Cancellation removes the callback before its future can finish.
                        if self.callbacks.remove(&call).is_some() {
                            let reply = match result {Ok(result)=>json!({"callId":call,"result":result}),Err(message)=>json!({"callId":call,"error":{"code":"DOXVELT_CALLBACK_FAILED","message":message}})};
                            self.send(&reply).await?;
                        }
                    }
                }
                line = self.lines.next_line() => {
                    let line = line.map_err(|_| failure("Could not read Reverie response."))?.ok_or_else(|| failure("Reverie stopped before completing the operation."))?;
                    let value: Value = serde_json::from_str(&line).map_err(|_| failure("Reverie returned an invalid response."))?;
                    if !value.is_object() { return Err(failure("Reverie returned an invalid response.")); }
                    if let Some(call) = value["cancelCall"].as_str() {
                        if let Some(handle) = self.callbacks.remove(call) {handle.abort();}
                    } else if value["callId"].is_string() {
                        self.callback(value)?;
                    } else if value["id"].as_u64() == Some(id) {
                        if value.get("error").is_some() {return Err(failure(value["error"]["message"].as_str().unwrap_or("Reverie could not complete the operation.")));}
                        return value.get("result").cloned().ok_or_else(|| failure("Reverie returned an invalid response."));
                    }
                }
            }
        }
    }
    pub async fn close(mut self) {
        self.tasks.abort_all();
        drop(self.input.take());
        if tokio::time::timeout(Duration::from_secs(3), self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.kill().await;
        }
    }
}
