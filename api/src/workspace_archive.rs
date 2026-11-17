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
/// Request-local projections. No source text or derived cache enters the wire
/// format. The basis binds reuse to the immutable stories that were projected.
pub struct SourcePlan {
    sources: HashMap<(String, String), Vec<Source>>,
    slots: HashMap<String, HashSet<String>>,
    basis: String,
    projections: usize,
}
impl SourcePlan {
    pub fn sources(&self, story: &str, publication: &str) -> Result<&[Source]> {
        self.sources
            .get(&(story.into(), publication.into()))
            .map(Vec::as_slice)
            .ok_or_else(|| invalid("A memory publication has no validated source projection."))
    }
    pub fn projection_count(&self) -> usize {
        self.projections
    }
}
pub fn prepare_sources(
    archive: &WorkspaceArchive,
    cancel: &dyn Fn() -> bool,
) -> Result<SourcePlan> {
    archive::check_cancelled(cancel)?;
    if archive.format != "doxvelt-workspace" || archive.version != 1 {
        return Err(invalid(
            "Unsupported Doxvelt workspace archive format or version.",
        ));
    }
    if archive.stories.len() > MAX_FILES || archive.memories.len() > MAX_FILES {
        return Err(invalid("Workspace archive record limits exceeded."));
    }
    let mut plan = SourcePlan {
        sources: HashMap::new(),
        slots: HashMap::new(),
        basis: fingerprint(&json!(archive.stories)),
        projections: 0,
    };
    for story in &archive.stories {
        let simulation = &story.simulation;
        archive::validate_cancellable(simulation, cancel)?;
        let reader = ArchiveReader::cancellable(simulation, cancel);
        let versions = array(&story.episode_memory, "publications")?;
        let mut unresolved = versions
            .iter()
            .map(|v| string(v, "id"))
            .collect::<Result<HashSet<_>>>()?;
        for version in versions {
            require_date(string(version, "date")?)?;
        }
        let mut slots = HashSet::new();
        for branch in &simulation.branches {
            reader.check_cancelled()?;
            let mut q = query(simulation);
            q.branch_id = branch.id.clone();
            let (scenes, bases, heads) =
                episode_memory::scenes_with_basis(&reader, &q, &HashMap::new())?;
            plan.projections += 1;
            slots.extend(scenes.iter().map(|s| s.slot.clone()));
            let mut historical = HashMap::new();
            'versions: for version in versions {
                let id = string(version, "id")?;
                if !unresolved.contains(id) {
                    continue;
                }
                for ((scene, basis), heads) in scenes.iter().zip(&bases).zip(&heads) {
                    if scene.slot != string(version, "slot")? {
                        continue;
                    }
                    let mut basis = basis.clone();
                    basis[1] = version["date"].clone();
                    if json_hash(&basis) == version["revision"] {
                        plan.sources.insert(
                            (simulation.simulation.id.clone(), id.into()),
                            scene.sources.clone(),
                        );
                        unresolved.remove(id);
                        continue 'versions;
                    }
                    // Locate a historical revision by its cheap identity
                    // hash. Replaying every preceding head would repeatedly
                    // project the whole transcript. A matching candidate is
                    // still re-projected and verified before its source is used.
                    if let Some(prefix) =
                        matching_prefix(&basis, string(version, "revision")?, cancel)?
                    {
                        let head = &heads[prefix];
                        if !historical.contains_key(head) {
                            q.head = Some(head.clone());
                            historical.insert(
                                head.clone(),
                                episode_memory::scenes_with_basis(&reader, &q, &HashMap::new())?,
                            );
                            plan.projections += 1;
                        }
                        let (old_scenes, old_bases, _) = &historical[head];
                        for (old, identity) in old_scenes.iter().zip(old_bases) {
                            if old.slot != scene.slot {
                                continue;
                            }
                            let mut identity = identity.clone();
                            identity[1] = version["date"].clone();
                            if json_hash(&identity) == version["revision"] {
                                plan.sources.insert(
                                    (simulation.simulation.id.clone(), id.into()),
                                    old.sources.clone(),
                                );
                                unresolved.remove(id);
                                continue 'versions;
                            }
                        }
                    }
                }
            }
        }
        if !unresolved.is_empty() {
            return Err(invalid(
                "A memory publication has no matching played source in the archived story paths.",
            ));
        }
        plan.slots.insert(simulation.simulation.id.clone(), slots);
    }
    Ok(plan)
}
/// Hash all historical prefixes in one pass over the revision IDs. Cloning the
/// small SHA state avoids serializing the growing transcript for every prefix.
fn matching_prefix(
    basis: &Value,
    revision: &str,
    cancel: &dyn Fn() -> bool,
) -> Result<Option<usize>> {
    let parts = basis
        .as_array()
        .ok_or_else(|| invalid("Invalid scene revision basis."))?;
    let ids = parts[3]
        .as_array()
        .ok_or_else(|| invalid("Invalid scene revision basis."))?;
    let mut state = Sha256::new();
    state.update(b"[");
    for part in &parts[..3] {
        state.update(serde_json::to_vec(part).unwrap());
        state.update(b",");
    }
    state.update(b"[");
    for prefix in 0..ids.len() {
        archive::check_cancelled(cancel)?;
        let mut plain = state.clone();
        plain.update(b"]]");
        if format!("{:x}", plain.finalize()) == revision {
            return Ok(Some(prefix));
        }
        if let Some(marker) = parts.get(4) {
            let mut marked = state.clone();
            marked.update(b"],");
            marked.update(serde_json::to_vec(marker).unwrap());
            marked.update(b"]");
            if format!("{:x}", marked.finalize()) == revision {
                return Ok(Some(prefix));
            }
        }
        if prefix > 0 {
            state.update(b",");
        }
        state.update(serde_json::to_vec(&ids[prefix]).unwrap());
    }
    Ok(None)
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
pub fn validate_host(archive: &WorkspaceArchive) -> Result<()> {
    let sources = prepare_sources(archive, &|| false)?;
    validate_host_with_sources(archive, &sources, &|| false)
}
pub fn validate_host_with_sources(
    archive: &WorkspaceArchive,
    sources: &SourcePlan,
    cancel: &dyn Fn() -> bool,
) -> Result<()> {
    archive::check_cancelled(cancel)?;
    if archive.format != "doxvelt-workspace" || archive.version != 1 {
        return Err(invalid(
            "Unsupported Doxvelt workspace archive format or version.",
        ));
    }
    collection::validate_configuration(&archive.configuration).map_err(|e| invalid(&e.message))?;
    if sources.basis != fingerprint(&json!(archive.stories)) {
        return Err(invalid(
            "Story history changed after preparing its source projections.",
        ));
    }
    if archive.stories.len() > MAX_FILES || archive.memories.len() > MAX_FILES {
        return Err(invalid("Workspace archive record limits exceeded."));
    }
    let mut stories = HashSet::new();
    let mut expected = HashSet::new();
    let mut files = HashSet::new();
    for story in &archive.stories {
        archive::check_cancelled(cancel)?;
        let simulation = &story.simulation;
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
        let reader = ArchiveReader::cancellable(simulation, cancel);
        let valid_slots = &sources.slots[&simulation.simulation.id];
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
            archive::check_cancelled(cancel)?;
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
            let sources = sources.sources(&simulation.simulation.id, id)?;
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
            archive::check_cancelled(cancel)?;
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
            let mut reader = reader.clone();
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
        archive::check_cancelled(cancel)?;
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
    source_files_filtered(root, false, &|| false)
}
pub fn restored_source_files(root: &Path) -> Result<BTreeMap<String, String>> {
    source_files_filtered(root, true, &|| false)
}
pub fn source_files_cancellable(
    root: &Path,
    restored: bool,
    cancel: &dyn Fn() -> bool,
) -> Result<BTreeMap<String, String>> {
    source_files_filtered(root, restored, cancel)
}
fn source_files_filtered(
    root: &Path,
    deployment: bool,
    cancel: &dyn Fn() -> bool,
) -> Result<BTreeMap<String, String>> {
    safe_fs::open_no_follow(root, true)?;
    fn visit(
        root: &Path,
        path: &Path,
        result: &mut BTreeMap<String, String>,
        used: &mut usize,
        deployment: bool,
        cancel: &dyn Fn() -> bool,
    ) -> Result<()> {
        for entry in fs::read_dir(path).map_err(safe_fs::io)? {
            archive::check_cancelled(cancel)?;
            let path = entry.map_err(safe_fs::io)?.path();
            if deployment && path == root.join(".doxvelt") {
                continue;
            }
            let metadata = fs::symlink_metadata(&path).map_err(safe_fs::io)?;
            if safe_fs::symlink(&metadata) {
                return Err(invalid("Archive source cannot contain symbolic links."));
            }
            if metadata.is_dir() {
                visit(root, &path, result, used, deployment, cancel)?;
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
    visit(root, root, &mut result, &mut 0, deployment, cancel)?;
    Ok(result)
}
pub fn stage_source(directory: &Path, parent: &Path) -> Result<TempDirectory> {
    let stage = TempDirectory::create(parent, ".doxvelt-export-")?;
    fs::create_dir(stage.path().join("source")).map_err(safe_fs::io)?;
    copy_sanitized_directory(directory, &stage.path().join("source"))?;
    Ok(stage)
}
pub fn read(package: &Path) -> Result<WorkspaceArchive> {
    Ok(read_cancellable(package, &|| false)?.0)
}
pub fn read_cancellable(
    package: &Path,
    cancel: &dyn Fn() -> bool,
) -> Result<(WorkspaceArchive, SourcePlan)> {
    let archive = read_integrity(package, cancel)?;
    let sources = prepare_sources(&archive, cancel)?;
    validate_host_with_sources(&archive, &sources, cancel)?;
    Ok((archive, sources))
}
/// After validation, identical checksummed bytes need only an integrity recheck,
/// not a second semantic replay of all historical commands and projections.
pub fn verify_unchanged(package: &Path, expected: &str, cancel: &dyn Fn() -> bool) -> Result<()> {
    let archive = read_integrity(package, cancel)?;
    if archive.checksum != expected {
        return Err(invalid("Archive changed during import. Preview again."));
    }
    Ok(())
}
fn read_integrity(package: &Path, cancel: &dyn Fn() -> bool) -> Result<WorkspaceArchive> {
    archive::check_cancelled(cancel)?;
    safe_fs::assert_no_symlink_components(package)?;
    safe_fs::open_no_follow(package, true)?;
    let bytes = safe_fs::read_regular_bounded(&package.join("workspace.json"), MAX_BYTES)?;
    if bytes.len() > MAX_BYTES {
        return Err(invalid("Workspace archive exceeds 256 MiB."));
    }
    let archive: WorkspaceArchive = serde_json::from_slice(&bytes)
        .map_err(|e| invalid(&format!("Invalid workspace archive: {e}")))?;
    archive::check_cancelled(cancel)?;
    if checksum(&archive) != archive.checksum
        || source_files_cancellable(&package.join("source"), false, cancel)? != archive.source_files
    {
        return Err(invalid(
            "Archive integrity check failed. Keep the original export and copy it again.",
        ));
    }
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
    stage_import_cancellable(parent, target, archive, source, &|| false)
}
pub fn stage_import_cancellable(
    parent: &Path,
    target: &Path,
    archive: &WorkspaceArchive,
    source: &Path,
    cancel: &dyn Fn() -> bool,
) -> Result<TempDirectory> {
    archive::check_cancelled(cancel)?;
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
            archive::check_cancelled(cancel)?;
            let mut simulation = story.simulation.clone();
            rewrite_source_root(&mut simulation, "source", &target.to_string_lossy())?;
            store.import_simulation_cancellable(simulation, cancel)?;
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
    fn prefix_hashes_match_the_canonical_revision_encoding() {
        for marker in [None, Some(json!("public-role-labels-v1"))] {
            let mut basis = json!([
                "first",
                "2000-01-01",
                "revision",
                ["quoted\"id", "line\nid", "third"]
            ]);
            if let Some(marker) = marker {
                basis.as_array_mut().unwrap().push(marker);
            }
            for prefix in 0..3 {
                let mut expected = basis.clone();
                expected[3].as_array_mut().unwrap().truncate(prefix);
                assert_eq!(
                    matching_prefix(&basis, &json_hash(&expected), &|| false).unwrap(),
                    Some(prefix)
                );
                expected.as_array_mut().unwrap().truncate(4);
                assert_eq!(
                    matching_prefix(&basis, &json_hash(&expected), &|| false).unwrap(),
                    Some(prefix)
                );
            }
            assert_eq!(
                matching_prefix(&basis, &json_hash(&basis), &|| false).unwrap(),
                None
            );
            assert!(matching_prefix(&basis, "absent", &|| true).is_err());
        }
    }
    #[test]
    fn publications_with_different_dates_reuse_branch_projections_and_cannot_reuse_changed_history()
    {
        let fixtures: Value =
            serde_json::from_str(include_str!("../tests/fixtures/archives.json")).unwrap();
        let simulation = archive::verify::decode_archive(&fixtures["complete"]).unwrap();
        let reader = ArchiveReader::new(&simulation);
        let (scenes, bases, _) =
            episode_memory::scenes_with_basis(&reader, &query(&simulation), &HashMap::new())
                .unwrap();
        let scene = scenes.iter().position(|s| !s.sources.is_empty()).unwrap();
        let mut publications = Vec::new();
        for (id, date) in [("one", "2000-01-01"), ("two", "2000-01-02")] {
            let mut basis = bases[scene].clone();
            basis[1] = json!(date);
            publications.push(
                json!({"id":id,"date":date,"slot":scenes[scene].slot,"revision":json_hash(&basis)}),
            );
        }
        let mut data = WorkspaceArchive {
            format: "doxvelt-workspace".into(),
            version: 1,
            configuration: json!({"version":1}),
            stories: vec![Story {
                simulation,
                episode_memory: json!({"dates":[],"publications":publications}),
                scene_headings: vec![],
            }],
            memories: vec![],
            source_files: BTreeMap::new(),
            checksum: String::new(),
        };
        let plan = prepare_sources(&data, &|| false).unwrap();
        assert_eq!(
            plan.projection_count(),
            data.stories[0].simulation.branches.len()
        );
        let story = &data.stories[0].simulation.simulation.id;
        assert_eq!(
            json!(plan.sources(story, "one").unwrap()),
            json!(plan.sources(story, "two").unwrap())
        );
        data.stories[0].simulation.commits[0]
            .id
            .push_str("-changed");
        assert!(
            validate_host_with_sources(&data, &plan, &|| false)
                .unwrap_err()
                .message
                .contains("changed after preparing")
        );
    }
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
