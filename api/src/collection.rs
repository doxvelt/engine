//! Registered-workspace authoring, deployment settings and immutable story setup.
use crate::{
    application::{StartRequest, start_from_compiled},
    content::{CompiledWorkspace, compile_workspace_with_sources},
    episode_memory::{EpisodeCatalog, EpisodeQuery, json_hash, require_date},
    error::{EngineError, ErrorCode},
    identity::{js_trim, sha256},
    safe_fs, source,
    storage::Store,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub struct CollectionError {
    pub status: u16,
    pub code: String,
    pub message: String,
}
type Result<T> = std::result::Result<T, CollectionError>;
fn error(code: &str, message: &str, status: u16) -> CollectionError {
    CollectionError {
        status,
        code: code.into(),
        message: message.into(),
    }
}
impl From<EngineError> for CollectionError {
    fn from(e: EngineError) -> Self {
        error(
            "workspace-operation-failed",
            &e.message,
            match e.code {
                ErrorCode::Invalid => 400,
                ErrorCode::NotFound => 404,
                ErrorCode::Conflict | ErrorCode::CommandConflict | ErrorCode::MemoryJobConflict => {
                    409
                }
                ErrorCode::Internal => 500,
            },
        )
    }
}
fn io(e: std::io::Error) -> CollectionError {
    safe_fs::io(e).into()
}
#[derive(Debug, Clone, Serialize)]
pub struct Location {
    pub root: PathBuf,
    pub data: PathBuf,
    pub configuration: PathBuf,
    pub database: PathBuf,
}
fn local_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(unc) = value.strip_prefix("\\\\?\\UNC\\") {
            return PathBuf::from(format!("\\\\{unc}"));
        }
        if let Some(value) = value.strip_prefix("\\\\?\\") {
            return PathBuf::from(value);
        }
    }
    path
}
pub fn location(directory: &Path) -> Result<Location> {
    let root = local_path(fs::canonicalize(directory).map_err(io)?);
    let data = root.join(".doxvelt");
    match fs::symlink_metadata(&data) {
        Ok(m) if !m.is_dir() || safe_fs::symlink(&m) => {
            return Err(error(
                "unsafe-data-directory",
                "The workspace's .doxvelt must be a local directory.",
                400,
            ));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(io(e)),
        _ => {}
    }
    for child in [
        "workspace.json",
        "runtime.sqlite",
        "scene-headings.sqlite",
        "memory",
        "memory/catalog.sqlite",
    ] {
        let path = data.join(child);
        match fs::symlink_metadata(&path) {
            Ok(m) => {
                let private = if child == "memory" {
                    m.is_dir() && !safe_fs::symlink(&m)
                } else {
                    safe_fs::private_file_identity(&path).is_ok()
                };
                if !private {
                    return Err(error(
                        "unsafe-data-path",
                        "Doxvelt data must stay in private files and directories inside this workspace.",
                        400,
                    ));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io(e)),
        }
    }
    Ok(Location {
        configuration: data.join("workspace.json"),
        database: data.join("runtime.sqlite"),
        root,
        data,
    })
}
pub fn validate_configuration(config: &Value) -> Result<()> {
    let Some(object) = config
        .as_object()
        .filter(|o| o.get("version").and_then(Value::as_f64) == Some(1.0))
    else {
        return Err(error(
            "invalid-configuration",
            "This workspace has an unsupported Doxvelt configuration.",
            400,
        ));
    };
    if object
        .keys()
        .any(|k| !["version", "actorModel", "reflectionModel"].contains(&k.as_str()))
    {
        return Err(error(
            "invalid-configuration",
            "Doxvelt workspace settings contain an unsupported field.",
            400,
        ));
    }
    for key in ["actorModel", "reflectionModel"] {
        if let Some(model) = object.get(key) {
            if !model.as_object().is_some_and(|o| {
                o.keys()
                    .all(|k| ["provider", "model"].contains(&k.as_str()))
                    && ["provider", "model"]
                        .iter()
                        .all(|k| model[*k].as_str().is_some_and(|s| !js_trim(s).is_empty()))
            }) {
                return Err(error(
                    "invalid-model",
                    "Choose a provider and model configured in DSH.",
                    400,
                ));
            }
        }
    }
    Ok(())
}
pub fn read_configuration(directory: &Path) -> Result<Value> {
    let location = location(directory)?;
    match fs::symlink_metadata(&location.configuration) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(io(e)),
        Ok(_) => {
            let bytes = safe_fs::read_regular(&location.configuration, true)?;
            let mut value: Value = serde_json::from_slice(&bytes).map_err(|_| {
                error(
                    "invalid-configuration",
                    "This workspace has an invalid Doxvelt configuration.",
                    400,
                )
            })?;
            validate_configuration(&value)?;
            value["version"] = json!(1); // JSON.stringify also writes authored 1.0 as 1.
            Ok(value)
        }
    }
}
fn cancelled(cancel: &impl Fn() -> bool) -> Result<()> {
    if cancel() {
        Err(error(
            "operation-aborted",
            "Workspace operation was cancelled.",
            503,
        ))
    } else {
        Ok(())
    }
}
fn configuration_publication(
    location: &Location,
    config: &Value,
    activate: bool,
    cancel: &impl Fn() -> bool,
) -> Result<()> {
    let temporary = location
        .data
        .join(format!(".workspace.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = safe_fs::exclusive_file(&temporary)?;
        file.write_all((serde_json::to_string_pretty(config).unwrap() + "\n").as_bytes())
            .map_err(io)?;
        file.sync_all().map_err(io)?;
        drop(file);
        cancelled(cancel)?;
        // Recheck the trusted path after staging and immediately before publish.
        self::location(&location.root)?;
        if activate {
            match fs::hard_link(&temporary, &location.configuration) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(io(e)),
            }
        } else {
            fs::rename(&temporary, &location.configuration).map_err(io)?;
        }
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result
}
pub fn activate(directory: &Path, cancel: &impl Fn() -> bool) -> Result<Value> {
    let location = location(directory)?;
    cancelled(cancel)?;
    fs::create_dir_all(&location.data).map_err(io)?;
    let current = read_configuration(directory)?;
    if !current.is_null() {
        return Ok(current);
    }
    configuration_publication(&location, &json!({"version":1}), true, cancel)?;
    read_configuration(directory)
}
pub fn save_configuration(
    directory: &Path,
    config: &Value,
    expected: &str,
    cancel: &impl Fn() -> bool,
) -> Result<Value> {
    validate_configuration(config)?;
    let mut normalized = config.clone();
    normalized["version"] = json!(1);
    let config = &normalized;
    let current = read_configuration(directory)?;
    if current.is_null() || json_hash(&current) != expected {
        return Err(error(
            "configuration-changed",
            "Workspace settings changed. Reopen settings before saving.",
            409,
        ));
    }
    let location = location(directory)?;
    configuration_publication(&location, config, false, cancel)?;
    Ok(json!({"configuration":config,"configurationRevision":json_hash(config)}))
}
pub fn snapshot(directory: &Path) -> Result<(CompiledWorkspace, Value)> {
    let location = location(directory)?;
    let (compiled, texts) = compile_workspace_with_sources(&location.root)?;
    let mut files = source::summaries(&compiled);
    for file in &mut files {
        let path = file["path"].as_str().unwrap();
        let text = texts.get(path).ok_or_else(|| {
            error(
                "collection-changed",
                "Source changed while reading the collection. Reopen it and try again.",
                409,
            )
        })?;
        if source::read(&location.root, path)?["text"] != *text {
            return Err(error(
                "collection-changed",
                "Source changed while reading the collection. Reopen it and try again.",
                409,
            ));
        }
        file["revision"] = json!(sha256(text));
    }
    let choices = |assets: &Vec<crate::content::Asset>| {
        assets
            .iter()
            .map(|a| json!({"id":a.id,"name":a.name}))
            .collect::<Vec<_>>()
    };
    let collection = json!({"revision":json_hash(&json!(files.iter().map(|f|json!([f["path"],f["revision"]])).collect::<Vec<_>>())) ,"worlds":choices(&compiled.worlds),"scenarios":choices(&compiled.scenarios),"formats":choices(&compiled.formats),"characters":compiled.entities.iter().filter(|a|a.kind.can_own_turn()).map(|a|json!({"id":a.id,"name":a.name})).collect::<Vec<_>>(),"files":files,"diagnostics":compiled.diagnostics});
    Ok((compiled, collection))
}
pub fn save_source(directory: &Path, input: &Value, cancel: &impl Fn() -> bool) -> Result<Value> {
    let location = location(directory)?;
    let path = input["path"].as_str();
    let text = input["text"].as_str();
    let (Some(path), Some(text)) = (path, text) else {
        return Err(error(
            "invalid-source",
            "Source text must be at most 500,000 characters.",
            400,
        ));
    };
    if path.encode_utf16().count() > 512 || text.encode_utf16().count() > 500_000 {
        return Err(error(
            "invalid-source",
            "Source text must be at most 500,000 characters.",
            400,
        ));
    }
    // A missing file is represented by null, never by an absent review token.
    if !input
        .get("expectedRevision")
        .is_some_and(|v| v.is_null() || v.is_string())
    {
        return Err(error(
            "source-changed",
            "This source changed. Reopen it before saving your changes.",
            409,
        ));
    }
    let current = match source::read(&location.root, path) {
        Ok(v) => Some(v["text"].as_str().unwrap().to_owned()),
        Err(e) if e.code == ErrorCode::Internal && !location.root.join(path).exists() => None,
        Err(e) => return Err(e.into()),
    };
    if current
        .as_ref()
        .map(|s| json!(sha256(s)))
        .unwrap_or(Value::Null)
        != input["expectedRevision"]
    {
        return Err(error(
            "source-changed",
            "This source changed. Reopen it before saving your changes.",
            409,
        ));
    }
    cancelled(cancel)?;
    source::publish_checked(&location.root, path, text, current.as_deref(), &|| {
        if cancel() {
            Err(EngineError::invalid("Workspace operation was cancelled."))
        } else {
            Ok(())
        }
    })?;
    Ok(json!({"path":path,"revision":sha256(text)}))
}
pub fn create_object(directory: &Path, input: &Value, cancel: &impl Fn() -> bool) -> Result<Value> {
    let kind = input["kind"].as_str().unwrap_or_default();
    let id = input["id"].as_str().unwrap_or_default();
    if !["world", "scenario", "character", "format"].contains(&kind)
        || id.is_empty()
        || id.len() > 80
        || !id.as_bytes()[0].is_ascii_lowercase() && !id.as_bytes()[0].is_ascii_digit()
        || !id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_')
    {
        return Err(error(
            "invalid-object",
            "Choose a short lowercase object ID using letters, digits, hyphens or underscores.",
            400,
        ));
    }
    let (Some(name), Some(body)) = (input["name"].as_str(), input["body"].as_str()) else {
        return Err(error(
            "invalid-object",
            "Enter a name and Markdown description.",
            400,
        ));
    };
    if js_trim(name).is_empty()
        || name.encode_utf16().count() > 120
        || name.chars().any(|c| c <= '\u{1f}')
        || body.encode_utf16().count() > 500_000
    {
        return Err(error(
            "invalid-object",
            "Enter a name and Markdown description.",
            400,
        ));
    }
    let filename = if kind == "character" {
        format!("entities/{id}/IDENTITY.md")
    } else {
        format!(
            "{}/{id}.md",
            match kind {
                "world" => "worlds",
                "scenario" => "scenarios",
                _ => "formats",
            }
        )
    };
    let text = format!(
        "---\nid: {id}\nname: {}\n{}---\n\n{body}\n",
        serde_json::to_string(js_trim(name)).unwrap(),
        if kind == "character" {
            "kind: agent\nvisibility: public\n"
        } else {
            ""
        }
    );
    save_source(
        directory,
        &json!({"path":filename,"text":text,"expectedRevision":null}),
        cancel,
    )
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorySetup {
    pub operation_id: String,
    pub collection_revision: String,
    pub world_id: String,
    pub scenario_id: String,
    pub format_id: String,
    pub character_ids: Vec<String>,
    pub date: String,
}
fn setup_identity(setup: &StorySetup) -> Value {
    let mut actors = setup.character_ids.clone();
    actors.sort();
    json!([
        setup.operation_id,
        setup.collection_revision,
        setup.world_id,
        setup.scenario_id,
        setup.format_id,
        actors,
        setup.date
    ])
}
fn dated_story(
    store: &Store,
    simulation: &str,
    branch: &str,
    setup: &StorySetup,
    memory_directory: &Path,
) -> Value {
    let query = EpisodeQuery {
        owner_scope: "local".into(),
        simulation_id: simulation.into(),
        branch_id: branch.into(),
        head: None,
    };
    let dated = (|| -> crate::error::Result<()> {
        let catalog = EpisodeCatalog::open(memory_directory)?;
        let scenes = catalog.inspect(store, &query)?;
        let first = scenes
            .iter()
            .find(|s| s["slot"] == "first")
            .ok_or_else(|| EngineError::invalid("First episode is unavailable."))?;
        if first["date"].is_null() {
            catalog.set_date(store, &query, "first", &setup.date)?;
        }
        Ok(())
    })();
    if dated.is_ok() {
        json!({"status":"complete","simulationId":simulation,"branchId":branch})
    } else {
        json!({"status":"partial","simulationId":simulation,"branchId":branch,"pending":"date","message":"The story is saved. Open Episode memory to retry setting its date."})
    }
}
fn resume(store: &Store, setup: &StorySetup, memory_directory: &Path) -> Result<Option<Value>> {
    let Some(sim) = store.simulation("local", &format!("story-{}", setup.operation_id))? else {
        return Ok(None);
    };
    let revision = store
        .revision("local", &sim.content_revision_id)?
        .ok_or_else(|| EngineError::invalid("Content revision is unavailable."))?;
    let recorded = revision
        .compiled
        .scenarios
        .iter()
        .find(|s| Some(&s.id) == sim.scenario_id.as_ref())
        .and_then(|s| s.metadata.get("doxvelt_setup"))
        .and_then(Value::as_str)
        .and_then(|s| serde_json::from_str::<StorySetup>(s).ok());
    if recorded.is_none_or(|recorded| setup_identity(&recorded) != setup_identity(setup)) {
        return Err(error(
            "operation-conflict",
            "This creation operation already belongs to another episode setup.",
            409,
        ));
    }
    Ok(Some(dated_story(
        store,
        &sim.id,
        &sim.default_branch_id,
        setup,
        memory_directory,
    )))
}
pub fn start_story(
    directory: &Path,
    input: &Value,
    memory_directory: &Path,
    cancel: &impl Fn() -> bool,
) -> Result<Value> {
    let op = input["operationId"].as_str().unwrap_or_default();
    if op.is_empty() || op.len() > 80 || !op.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err(error(
            "invalid-operation",
            "Story creation needs a stable operation ID.",
            400,
        ));
    }
    if input["date"]
        .as_str()
        .is_none_or(|date| require_date(date).is_err())
    {
        return Err(error(
            "invalid-date",
            "Enter the episode's fictional date as YYYY-MM-DD.",
            400,
        ));
    }
    let setup: StorySetup = serde_json::from_value(input.clone()).map_err(|_| {
        error(
            "incomplete-setup",
            "Choose a world, scenario, format and at least one character from this workspace.",
            400,
        )
    })?;
    if setup.character_ids.is_empty() {
        return Err(error(
            "incomplete-setup",
            "Choose a world, scenario, format and at least one character from this workspace.",
            400,
        ));
    }
    let location = location(directory)?;
    if read_configuration(directory)?.is_null() {
        return Err(error(
            "inactive-workspace",
            "Activate Doxvelt in this workspace first.",
            409,
        ));
    }
    cancelled(cancel)?;
    {
        let store = Store::open(&location.database)?;
        if let Some(saved) = resume(&store, &setup, memory_directory)? {
            return Ok(saved);
        }
    }
    let (mut compiled, collection) = snapshot(directory)?;
    if collection["revision"] != setup.collection_revision {
        return Err(error(
            "collection-changed",
            "The collection changed. Review the episode setup and try again.",
            409,
        ));
    }
    let world = compiled
        .worlds
        .iter()
        .find(|a| a.id == setup.world_id)
        .cloned();
    let scenario = compiled
        .scenarios
        .iter()
        .find(|a| a.id == setup.scenario_id)
        .cloned();
    let format = compiled
        .formats
        .iter()
        .find(|a| a.id == setup.format_id)
        .cloned();
    let actors: HashSet<_> = setup.character_ids.iter().collect();
    let (Some(world), Some(mut scenario), Some(format)) = (world, scenario, format) else {
        return Err(error(
            "incomplete-setup",
            "Choose a world, scenario, format and at least one character from this workspace.",
            400,
        ));
    };
    if actors.len() != setup.character_ids.len()
        || actors.iter().any(|id| {
            !compiled
                .entities
                .iter()
                .any(|a| a.kind.can_own_turn() && a.id == ***id)
        })
    {
        return Err(error(
            "incomplete-setup",
            "Choose a world, scenario, format and at least one character from this workspace.",
            400,
        ));
    }
    if compiled.diagnostics.iter().any(|d| d.severity == "error") {
        return Err(error(
            "invalid-collection",
            "Resolve the collection's source errors before starting a story.",
            400,
        ));
    }
    compiled
        .entities
        .retain(|a| !a.kind.can_own_turn() || actors.contains(&a.id));
    let ids: HashSet<_> = compiled.entities.iter().map(|a| a.id.clone()).collect();
    compiled.connections.retain(|a| {
        a.metadata
            .get("entities")
            .and_then(Value::as_array)
            .is_some_and(|a| {
                a.iter()
                    .all(|id| id.as_str().is_some_and(|id| ids.contains(id)))
            })
    });
    let mut files: HashSet<String> = [
        world.path.clone(),
        scenario.path.clone(),
        format.path.clone(),
    ]
    .into_iter()
    .collect();
    files.extend(compiled.entities.iter().flat_map(|a| a.files.clone()));
    files.extend(compiled.connections.iter().map(|a| a.path.clone()));
    compiled
        .tagged_lines
        .retain(|r| files.contains(&r.source_span.file));
    compiled
        .mentions
        .retain(|r| files.contains(&r.source_span.file));
    compiled
        .beliefs
        .retain(|r| ids.contains(&r.holder) && files.contains(&r.source_span.file));
    compiled
        .surfaces
        .retain(|r| ids.contains(&r.entity) && files.contains(&r.source_span.file));
    compiled.access_links.retain(|r| {
        ids.contains(&r.member) && ids.contains(&r.container) && files.contains(&r.source_span.file)
    });
    scenario.metadata.insert(
        "doxvelt_setup".into(),
        json!(serde_json::to_string(input).unwrap()),
    );
    compiled.models.clear();
    compiled.worlds = vec![world];
    compiled.scenarios = vec![scenario];
    compiled.formats = vec![format];
    cancelled(cancel)?;
    let mut store = Store::open(&location.database)?;
    if let Some(saved) = resume(&store, &setup, memory_directory)? {
        return Ok(saved);
    }
    if snapshot(directory)?.1["revision"] != setup.collection_revision {
        return Err(error(
            "collection-changed",
            "The collection changed while preparing the story. Review the setup and try again.",
            409,
        ));
    }
    cancelled(cancel)?;
    let started = start_from_compiled(
        &mut store,
        StartRequest {
            owner_scope: "local",
            simulation_id: &format!("story-{}", setup.operation_id),
            command_id: &format!("start-{}", setup.operation_id),
            scenario_id: Some(setup.scenario_id.clone()),
            branch_id: Some("main".into()),
        },
        compiled,
    );
    // Another host can win the exact creation while this process was compiling.
    match started {
        Ok(started) => Ok(dated_story(
            &store,
            &started.simulation.id,
            &started.branch.id,
            &setup,
            memory_directory,
        )),
        Err(e) => resume(&store, &setup, memory_directory)?.ok_or_else(|| e.into()),
    }
}
pub fn execute(
    directory: &Path,
    action: &str,
    input: &Value,
    cancel: &impl Fn() -> bool,
) -> Result<Value> {
    cancelled(cancel)?;
    match action {
        "location" => Ok(json!(location(directory)?)),
        "configuration.read" => read_configuration(directory),
        "activate" => activate(directory, cancel),
        "configuration.save" => save_configuration(
            directory,
            &input["configuration"],
            input["expectedRevision"].as_str().unwrap_or_default(),
            cancel,
        ),
        "collection" => Ok(snapshot(directory)?.1),
        "source.create" => create_object(directory, input, cancel),
        "source.save" => save_source(directory, input, cancel),
        "source.read" => Ok(source::read(
            &location(directory)?.root,
            input["path"]
                .as_str()
                .ok_or_else(|| error("invalid-source", "Choose a source file.", 400))?,
        )?),
        "story.start" => start_story(
            directory,
            &input["setup"],
            Path::new(input["memoryDirectory"].as_str().ok_or_else(|| {
                error(
                    "invalid-memory-directory",
                    "Memory service configuration is unavailable.",
                    400,
                )
            })?),
            cancel,
        ),
        _ => Err(error(
            "invalid-operation",
            "Unknown workspace operation.",
            400,
        )),
    }
}
