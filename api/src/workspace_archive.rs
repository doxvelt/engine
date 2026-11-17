//! Logical workspace archives. Reverie's payloads are opaque to persistence:
//! the application host validates and restores them using the Reverie API.
use crate::{
    archive::{self, ArchiveReader, SimulationArchive},
    collection,
    draft_contracts::exact,
    episode_memory::{self, EpisodeCatalog, EpisodeQuery, Source, json_hash, require_date},
    error::{EngineError, Result},
    identity::fingerprint,
    portable::{copy_sanitized_directory, rewrite_source_root},
    ports::SimulationReader,
    projection::{array, string},
    safe_fs::{self, TempDirectory},
    scene_store::SceneHeadingStore,
    storage::Store,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

pub const MAX_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_FILES: usize = 10_000;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Story {
    pub simulation: SimulationArchive,
    pub episode_memory: Value,
    pub scene_headings: Vec<Value>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeMemory {
    pub simulation_id: String,
    pub publication_id: String,
    pub character_id: String,
    pub archive: Value,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceArchive {
    pub format: String,
    pub version: u32,
    pub configuration: Value,
    pub stories: Vec<Story>,
    pub memories: Vec<NativeMemory>,
    pub source_files: BTreeMap<String, String>,
    pub checksum: String,
}
fn invalid(message: &str) -> EngineError {
    EngineError::invalid(message)
}
pub fn checksum(archive: &WorkspaceArchive) -> String {
    let mut value = serde_json::to_value(archive).unwrap();
    value.as_object_mut().unwrap().remove("checksum");
    fingerprint(&value)
}
fn query(simulation: &SimulationArchive) -> EpisodeQuery {
    EpisodeQuery {
        owner_scope: simulation.simulation.owner_scope.clone(),
        simulation_id: simulation.simulation.id.clone(),
        branch_id: simulation.simulation.default_branch_id.clone(),
        head: None,
    }
}
/// Each store supplies its own coherent read snapshot. The application captures
/// this a second time before publication and rejects any cross-store drift.
pub fn capture(directory: &Path) -> Result<WorkspaceArchive> {
    let location = collection::location(directory).map_err(|e| invalid(&e.message))?;
    let configuration =
        collection::read_configuration(directory).map_err(|e| invalid(&e.message))?;
    if configuration.is_null() {
        return Err(invalid("Activate this Doxvelt workspace before exporting."));
    }
    let simulations = if location.database.exists() {
        Store::open(&location.database)?.export_all("local")?
    } else {
        vec![]
    };
    let catalog_path = location.data.join("memory");
    let catalog = if catalog_path.join("catalog.sqlite").exists() {
        Some(EpisodeCatalog::open(&catalog_path)?)
    } else {
        None
    };
    let headings_path = location.data.join("scene-headings.sqlite");
    let headings = if headings_path.exists() {
        Some(SceneHeadingStore::open(&headings_path)?)
    } else {
        None
    };
    let mut stories = Vec::new();
    for mut simulation in simulations {
        let q = query(&simulation);
        let memory = match &catalog {
            Some(c) => c.export_story(&q)?,
            None => json!({"dates":[],"publications":[]}),
        };
        let scene_headings = match &headings {
            Some(h) => h.export_story("local", &q.simulation_id)?,
            None => vec![],
        };
        let before = simulation.simulation.source_root.clone();
        rewrite_source_root(&mut simulation, &before, "source")?;
        stories.push(Story {
            simulation,
            episode_memory: memory,
            scene_headings,
        });
    }
    Ok(WorkspaceArchive {
        format: "doxvelt-workspace".into(),
        version: 1,
        configuration,
        stories,
        memories: vec![],
        source_files: BTreeMap::new(),
        checksum: String::new(),
    })
}
pub fn source_for(story: &Story, publication: &Value) -> Result<Vec<Source>> {
    let simulation = &story.simulation;
    let reader = ArchiveReader::new(simulation);
    let slot = string(publication, "slot")?;
    let date = string(publication, "date")?;
    require_date(date)?;
    let mut dates = HashMap::new();
    dates.insert(slot.to_owned(), date.to_owned());
    for branch in &simulation.branches {
        let mut q = query(simulation);
        q.branch_id = branch.id.clone();
        let ancestry = reader.ancestry(&q.owner_scope, &q.simulation_id, &branch.head_commit_id)?;
        for commit in ancestry.iter().rev() {
            q.head = Some(commit.id.clone());
            for scene in episode_memory::scenes(&reader, &q, &dates)? {
                if scene.slot == slot && scene.revision == publication["revision"] {
                    return Ok(scene.sources);
                }
            }
        }
    }
    Err(invalid(
        "A memory publication has no matching played source in the archived story paths.",
    ))
}
pub fn validate_host(archive: &WorkspaceArchive) -> Result<()> {
    if archive.format != "doxvelt-workspace" || archive.version != 1 {
        return Err(invalid(
            "Unsupported Doxvelt workspace archive format or version.",
        ));
    }
    collection::validate_configuration(&archive.configuration).map_err(|e| invalid(&e.message))?;
    if archive.stories.len() > MAX_FILES || archive.memories.len() > MAX_FILES {
        return Err(invalid("Workspace archive record limits exceeded."));
    }
    let mut stories = HashSet::new();
    let mut expected = HashSet::new();
    let mut files = HashSet::new();
    for story in &archive.stories {
        let simulation = &story.simulation;
        archive::validate(simulation)?;
        if simulation.simulation.owner_scope != "local"
            || simulation.simulation.source_root != "source"
            || !stories.insert(&simulation.simulation.id)
        {
            return Err(invalid(
                "Duplicate story, invalid owner or nonportable source root.",
            ));
        }
        exact(
            &story.episode_memory,
            &["dates", "publications"],
            &[],
            "Episode memory archive",
        )?;
        let mut slots = HashSet::new();
        let reader = ArchiveReader::new(simulation);
        let valid_slots = simulation
            .branches
            .iter()
            .map(|b| {
                episode_memory::scenes(
                    &reader,
                    &EpisodeQuery {
                        branch_id: b.id.clone(),
                        ..query(simulation)
                    },
                    &HashMap::new(),
                )
            })
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .map(|s| s.slot)
            .collect::<HashSet<_>>();
        for date in array(&story.episode_memory, "dates")? {
            exact(date, &["slot", "date"], &[], "Episode date")?;
            require_date(string(date, "date")?)?;
            let slot = string(date, "slot")?;
            if !slots.insert(slot) || !valid_slots.contains(slot) {
                return Err(invalid(
                    "An episode date is duplicated or has no story episode.",
                ));
            }
        }
        let mut publications = HashSet::new();
        for version in array(&story.episode_memory, "publications")? {
            exact(
                version,
                &[
                    "id",
                    "slot",
                    "revision",
                    "date",
                    "label",
                    "dependencies",
                    "characters",
                ],
                &[],
                "Memory publication",
            )?;
            let id = string(version, "id")?;
            if !publications.insert(id)
                || id
                    != json_hash(&json!([
                        episode_memory::story(&query(simulation)),
                        version["revision"],
                        version["dependencies"]
                    ]))
            {
                return Err(invalid("Invalid or duplicate memory publication identity."));
            }
            let sources = source_for(story, version)?;
            let mut characters = HashSet::new();
            for c in array(version, "characters")? {
                exact(
                    c,
                    &["file", "characterId", "memories", "impressions"],
                    &[],
                    "Memory character",
                )?;
                let actor = string(c, "characterId")?;
                let file = string(c, "file")?;
                if !characters.insert(actor)
                    || !sources.iter().any(|s| s.character_id == actor)
                    || !files.insert(file)
                    || !valid_memory_file(file)
                {
                    return Err(invalid(
                        "Invalid memory character, duplicate file or source.",
                    ));
                }
                expected.insert((simulation.simulation.id.as_str(), id, actor));
            }
            if characters.len() != sources.len() {
                return Err(invalid(
                    "A publication must contain every remembering character.",
                ));
            }
        }
        for version in array(&story.episode_memory, "publications")? {
            let mut dependencies = HashSet::new();
            for dep in array(version, "dependencies")? {
                let id = dep
                    .as_str()
                    .ok_or_else(|| invalid("Invalid memory dependency."))?;
                let prior = array(&story.episode_memory, "publications")?
                    .iter()
                    .find(|p| p["id"] == id)
                    .ok_or_else(|| invalid("A memory dependency is missing."))?;
                if !dependencies.insert(id) || prior["date"].as_str() >= version["date"].as_str() {
                    return Err(invalid(
                        "Memory dependencies must be distinct and earlier in the story.",
                    ));
                }
            }
        }
        let mut heading_ids = HashSet::new();
        for record in &story.scene_headings {
            exact(
                record,
                &["command", "input", "heading"],
                &[],
                "Scene heading archive",
            )?;
            let heading = &record["heading"];
            exact(
                heading,
                &["id", "title", "branchId", "anchor", "slot", "after"],
                &[],
                "Scene heading",
            )?;
            let id = string(record, "command")?;
            let command = crate::model::Command {
                owner_scope: "local".into(),
                simulation_id: simulation.simulation.id.clone(),
                branch_id: string(heading, "branchId")?.into(),
                expected_head: string(heading, "anchor")?.into(),
                command_id: id.into(),
                payload: Value::Null,
            };
            let input = record["input"]
                .as_array()
                .filter(|a| a.len() == 3)
                .ok_or_else(|| invalid("Invalid scene heading receipt."))?;
            let title = input[2]
                .as_str()
                .ok_or_else(|| invalid("Invalid scene heading receipt title."))?;
            if !heading_ids.insert(id)
                || input[0] != command.branch_id
                || input[1] != command.expected_head
                || heading["id"] != format!("scene:{id}")
            {
                return Err(invalid("Invalid scene heading identity or receipt."));
            }
            let mut reader = ArchiveReader::new(simulation);
            reader
                .heads
                .insert(command.branch_id.clone(), command.expected_head.clone());
            if crate::scene::make(&reader, &command, title)? != *heading {
                return Err(invalid(
                    "A scene heading does not match its archived story position.",
                ));
            }
        }
    }
    let mut seen = HashSet::new();
    for memory in &archive.memories {
        let key = (
            memory.simulation_id.as_str(),
            memory.publication_id.as_str(),
            memory.character_id.as_str(),
        );
        if !seen.insert(key) || !expected.contains(&key) {
            return Err(invalid("Duplicate or unreferenced native memory payload."));
        }
        let story = archive
            .stories
            .iter()
            .find(|s| s.simulation.simulation.id == memory.simulation_id)
            .unwrap();
        let publication = array(&story.episode_memory, "publications")?
            .iter()
            .find(|v| v["id"] == memory.publication_id)
            .unwrap();
        let character = array(publication, "characters")?
            .iter()
            .find(|c| c["characterId"] == memory.character_id)
            .unwrap();
        let native = &memory.archive;
        let contributions = array(native, "contributions")?;
        let at = chrono::NaiveDate::parse_from_str(string(publication, "date")?, "%Y-%m-%d")
            .map_err(|_| invalid("Invalid memory date."))?
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp_millis();
        if native["characterId"] != memory.character_id
            || array(native, "episodes")?.len() != 1
            || native["episodes"][0]["id"] != publication["revision"]
            || native["episodes"][0]["start"] != at
            || native["episodes"][0]["now"] != at
            || native["episodes"][0]["included"] != true
            || contributions.len() != 1
            || contributions[0]["episodeId"] != publication["revision"]
            || contributions[0]["start"] != at
            || contributions[0]["end"] != at
            || contributions[0]["label"] != publication["label"]
            || contributions[0]["memories"] != character["memories"]
            || contributions[0]["impressions"] != character["impressions"]
        {
            return Err(invalid(
                "Native memory does not match its host publication.",
            ));
        }
    }
    if seen != expected {
        return Err(invalid("The archive is missing published native memories."));
    }
    Ok(())
}
pub fn valid_memory_file(file: &str) -> bool {
    file.strip_suffix(".sqlite")
        .and_then(|s| uuid::Uuid::parse_str(s).ok())
        .is_some_and(|id| format!("{id}.sqlite") == file)
}
pub fn source_files(root: &Path) -> Result<BTreeMap<String, String>> {
    source_files_filtered(root, false)
}
pub fn restored_source_files(root: &Path) -> Result<BTreeMap<String, String>> {
    source_files_filtered(root, true)
}
fn source_files_filtered(root: &Path, deployment: bool) -> Result<BTreeMap<String, String>> {
    safe_fs::open_no_follow(root, true)?;
    fn visit(
        root: &Path,
        path: &Path,
        result: &mut BTreeMap<String, String>,
        used: &mut usize,
        deployment: bool,
    ) -> Result<()> {
        for entry in fs::read_dir(path).map_err(safe_fs::io)? {
            let path = entry.map_err(safe_fs::io)?.path();
            if deployment && path == root.join(".doxvelt") {
                continue;
            }
            let metadata = fs::symlink_metadata(&path).map_err(safe_fs::io)?;
            if safe_fs::symlink(&metadata) {
                return Err(invalid("Archive source cannot contain symbolic links."));
            }
            if metadata.is_dir() {
                visit(root, &path, result, used, deployment)?;
            } else {
                let bytes = safe_fs::read_regular_bounded(&path, MAX_BYTES.saturating_sub(*used))?;
                *used += bytes.len();
                if *used > MAX_BYTES || result.len() >= MAX_FILES {
                    return Err(invalid(
                        "Archive source exceeds the size or file-count limit.",
                    ));
                }
                let relative = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                if relative
                    .split('/')
                    .any(|p| p.starts_with(".doxvelt-import-"))
                {
                    return Err(invalid("Archive contains an unfinished import."));
                }
                result.insert(relative, format!("{:x}", Sha256::digest(&bytes)));
            }
        }
        Ok(())
    }
    let mut result = BTreeMap::new();
    visit(root, root, &mut result, &mut 0, deployment)?;
    Ok(result)
}
pub fn stage_source(directory: &Path, parent: &Path) -> Result<TempDirectory> {
    let stage = TempDirectory::create(parent, ".doxvelt-export-")?;
    fs::create_dir(stage.path().join("source")).map_err(safe_fs::io)?;
    copy_sanitized_directory(directory, &stage.path().join("source"))?;
    Ok(stage)
}
pub fn read(package: &Path) -> Result<WorkspaceArchive> {
    safe_fs::assert_no_symlink_components(package)?;
    safe_fs::open_no_follow(package, true)?;
    let bytes = safe_fs::read_regular_bounded(&package.join("workspace.json"), MAX_BYTES)?;
    if bytes.len() > MAX_BYTES {
        return Err(invalid("Workspace archive exceeds 256 MiB."));
    }
    let archive: WorkspaceArchive = serde_json::from_slice(&bytes)
        .map_err(|e| invalid(&format!("Invalid workspace archive: {e}")))?;
    if checksum(&archive) != archive.checksum
        || source_files(&package.join("source"))? != archive.source_files
    {
        return Err(invalid(
            "Archive integrity check failed. Keep the original export and copy it again.",
        ));
    }
    validate_host(&archive)?;
    Ok(archive)
}
pub fn write(package: &Path, archive: &WorkspaceArchive) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(archive).map_err(|e| invalid(&e.to_string()))?;
    if bytes.len() > MAX_BYTES {
        return Err(invalid("Workspace archive exceeds 256 MiB."));
    }
    use std::io::Write;
    let mut file = safe_fs::exclusive_file(&package.join("workspace.json"))?;
    file.write_all(&bytes).map_err(safe_fs::io)?;
    file.sync_all().map_err(safe_fs::io)
}
pub fn stage_import(
    parent: &Path,
    target: &Path,
    archive: &WorkspaceArchive,
    source: &Path,
) -> Result<TempDirectory> {
    let stage = TempDirectory::create(parent, ".doxvelt-restore-")?;
    let root = stage.path().join("workspace");
    safe_fs::copy_verified(source, &root)?;
    let data = root.join(".doxvelt");
    // Source data must never supply deployment state or databases.
    if data.exists() || root.join(".dsh").exists() || root.join(".git").exists() {
        return Err(invalid("Archive source contains reserved deployment data."));
    }
    fs::create_dir(&data).map_err(safe_fs::io)?;
    {
        let mut store = Store::open(&data.join("runtime.sqlite"))?;
        let mut catalog = EpisodeCatalog::open(&data.join("memory"))?;
        let mut headings = SceneHeadingStore::open(&data.join("scene-headings.sqlite"))?;
        for story in &archive.stories {
            let mut simulation = story.simulation.clone();
            rewrite_source_root(&mut simulation, "source", &target.to_string_lossy())?;
            store.import_simulation(simulation)?;
            catalog.import_story(&query(&story.simulation), &story.episode_memory)?;
            headings.import_story(
                "local",
                &story.simulation.simulation.id,
                &story.scene_headings,
            )?;
        }
    }
    fs::write(
        data.join("workspace.json"),
        serde_json::to_vec_pretty(&archive.configuration).unwrap(),
    )
    .map_err(safe_fs::io)?;
    Ok(stage)
}
pub fn summary(archive: &WorkspaceArchive, target: &Path) -> Value {
    json!({"archiveHash":archive.checksum,"targetDir":target.to_string_lossy(),"stories":archive.stories.len(),"branches":archive.stories.iter().map(|s|s.simulation.branches.len()).sum::<usize>(),"memoryPublications":archive.stories.iter().map(|s|s.episode_memory["publications"].as_array().map_or(0,Vec::len)).sum::<usize>(),"characterMemories":archive.memories.len(),"sourceFiles":archive.source_files.len(),"modelCalls":0})
}
pub fn target_path(target: &Path) -> Result<PathBuf> {
    let target = safe_fs::absolute(target)?;
    safe_fs::assert_no_symlink_components(&target)?;
    safe_fs::absent(&target)?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn staged_directory_publication_never_replaces_an_existing_destination() {
        let root = TempDirectory::create(&std::env::temp_dir(), "doxvelt-atomic-archive-").unwrap();
        let staged = root.path().join("staged");
        let target = root.path().join("target");
        fs::create_dir(&staged).unwrap();
        fs::write(staged.join("story"), "Complete archive").unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(target.join("keep"), "Existing workspace").unwrap();
        assert!(safe_fs::publish_directory(&staged, &target).is_err());
        assert_eq!(
            fs::read_to_string(target.join("keep")).unwrap(),
            "Existing workspace"
        );
        assert_eq!(
            fs::read_to_string(staged.join("story")).unwrap(),
            "Complete archive"
        );
        let fresh = root.path().join("fresh");
        safe_fs::publish_directory(&staged, &fresh).unwrap();
        assert!(!staged.exists());
        assert_eq!(
            fs::read_to_string(fresh.join("story")).unwrap(),
            "Complete archive"
        );
    }
    #[test]
    fn unknown_workspace_formats_and_unreferenced_memory_cannot_pass_validation() {
        let mut archive = WorkspaceArchive {
            format: "doxvelt-workspace".into(),
            version: 1,
            configuration: json!({"version":1}),
            stories: vec![],
            memories: vec![],
            source_files: BTreeMap::new(),
            checksum: String::new(),
        };
        validate_host(&archive).unwrap();
        archive.version = 2;
        assert!(validate_host(&archive).is_err());
        archive.version = 1;
        archive.memories.push(NativeMemory {
            simulation_id: "unknown".into(),
            publication_id: "unknown".into(),
            character_id: "mara".into(),
            archive: json!({}),
        });
        assert!(validate_host(&archive).is_err());
    }
}
