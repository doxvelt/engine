//! Workspace transfer orchestration. Doxvelt owns the package and canonical
//! history; all native memory passes through Reverie's public protocol.
use crate::{HostError, Reply, reverie::Session};
use doxvelt_engine::{
    collection,
    episode_memory::MemoryConfiguration,
    error::EngineError,
    projection::{array, string},
    safe_fs,
    workspace_archive::{self as archive, NativeMemory},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

type Result<T> = std::result::Result<T, HostError>;
fn invalid(message: &str) -> HostError {
    EngineError::invalid(message).into()
}
fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::SeqCst) {
        Err(invalid(
            "Workspace transfer was cancelled. Retry with the same archive and destination.",
        ))
    } else {
        Ok(())
    }
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> doxvelt_engine::error::Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| invalid("Workspace transfer worker failed."))?
        .map_err(Into::into)
}
fn configuration(directory: &Path, body: &Value) -> Result<MemoryConfiguration> {
    let config: MemoryConfiguration = serde_json::from_value(body["memory"].clone())
        .map_err(|_| invalid("The host must supply its Reverie service configuration."))?;
    let location = collection::location(directory).map_err(|e| invalid(&e.message))?;
    let memory = safe_fs::absolute(Path::new(&config.directory))?;
    safe_fs::assert_no_symlink_components(&memory)?;
    let parent = memory
        .parent()
        .ok_or_else(|| invalid("Reverie memory must belong to this workspace."))?;
    if memory
        .file_name()
        .is_none_or(|n| !n.to_string_lossy().eq_ignore_ascii_case("memory"))
        || safe_fs::identity(parent, true)? != safe_fs::identity(&location.data, true)?
    {
        return Err(invalid("Reverie memory must belong to this workspace."));
    }
    Ok(config)
}
pub async fn execute(
    directory: PathBuf,
    action: String,
    body: Value,
    cancel: Arc<AtomicBool>,
) -> Reply {
    match run(directory, action, body, cancel).await {
        Ok(value) => Reply::ok(value),
        Err(e) => Reply::error(e.status, &e.message),
    }
}
async fn run(
    directory: PathBuf,
    action: String,
    body: Value,
    cancel: Arc<AtomicBool>,
) -> Result<Value> {
    check(&cancel)?;
    let target = safe_fs::absolute(Path::new(string(&body, "targetDir")?))?;
    safe_fs::assert_no_symlink_components(&target)?;
    let configuration = configuration(&directory, &body)?;
    if action == "archive.export" {
        safe_fs::absent(&target)?;
        let directory = safe_fs::absolute(&directory)?;
        if safe_fs::contained(&directory, &target) || safe_fs::contained(&target, &directory) {
            return Err(invalid(
                "Choose an archive destination outside the workspace.",
            ));
        }
        let parent = target
            .parent()
            .ok_or_else(|| invalid("Choose an archive destination with a parent directory."))?
            .to_path_buf();
        let d = directory.clone();
        let mut snapshot = blocking(move || archive::capture(&d)).await?;
        let before = serde_json::to_value(&snapshot).unwrap();
        let d = directory.clone();
        let p = parent.clone();
        let stage = blocking(move || archive::stage_source(&d, &p)).await?;
        snapshot.source_files = archive::source_files(&stage.path().join("source"))?;
        let mut revisions = Vec::new();
        for story in &snapshot.stories {
            for version in array(&story.episode_memory, "publications")? {
                let sources = archive::source_for(story, version)?;
                for character in array(version, "characters")? {
                    check(&cancel)?;
                    let actor = string(character, "characterId")?;
                    let file = string(character, "file")?;
                    if !archive::valid_memory_file(file) {
                        return Err(invalid("Invalid memory database identity."));
                    }
                    let path = Path::new(&configuration.directory).join(file);
                    safe_fs::private_file_identity(&path)?;
                    let source = sources
                        .iter()
                        .find(|s| s.character_id == actor)
                        .ok_or_else(|| invalid("A memory character has no played source."))?;
                    let mut session =
                        Session::open(&configuration, &path.to_string_lossy(), actor, None).await?;
                    session.supply_source(string(version, "revision")?, source.observation.clone());
                    let exported = session.request("exportMemory", json!({})).await;
                    session.close().await;
                    let exported = exported?;
                    revisions.push((path, actor.to_owned(), exported["revision"].clone()));
                    snapshot.memories.push(NativeMemory {
                        simulation_id: story.simulation.simulation.id.clone(),
                        publication_id: string(version, "id")?.into(),
                        character_id: actor.into(),
                        archive: exported["archive"].clone(),
                    });
                }
            }
        }
        archive::validate_host(&snapshot)?;
        let d = directory.clone();
        let after = blocking(move || archive::capture(&d)).await?;
        if serde_json::to_value(after).unwrap() != before {
            return Err(invalid(
                "Workspace history, dates or memories changed during export. Retry the export.",
            ));
        }
        let d = directory.clone();
        let p = parent;
        let second = blocking(move || archive::stage_source(&d, &p)).await?;
        if archive::source_files(&second.path().join("source"))? != snapshot.source_files {
            return Err(invalid(
                "Authored source changed during export. Retry the export.",
            ));
        }
        for (path, actor, revision) in revisions {
            check(&cancel)?;
            let mut session =
                Session::open(&configuration, &path.to_string_lossy(), &actor, None).await?;
            let status = session.request("status", json!({})).await;
            session.close().await;
            if status?["revision"] != revision {
                return Err(invalid(
                    "Published memory changed during export. Retry the export.",
                ));
            }
        }
        snapshot.checksum = archive::checksum(&snapshot);
        archive::write(stage.path(), &snapshot)?;
        // Never publish the staging directory's private ownership marker.
        let ready = stage.path().join("package");
        fs::create_dir(&ready).map_err(safe_fs::io)?;
        fs::rename(stage.path().join("source"), ready.join("source")).map_err(safe_fs::io)?;
        fs::rename(
            stage.path().join("workspace.json"),
            ready.join("workspace.json"),
        )
        .map_err(safe_fs::io)?;
        check(&cancel)?;
        safe_fs::publish_directory(&ready, &target)?;
        return Ok(json!({"status":"exported","summary":archive::summary(&snapshot,&target)}));
    }
    let package = safe_fs::absolute(Path::new(string(&body, "packageDir")?))?;
    if safe_fs::contained(&package, &target) || safe_fs::contained(&target, &package) {
        return Err(invalid(
            "The archive and restored workspace must have separate locations.",
        ));
    }
    let p = package.clone();
    let snapshot = blocking(move || archive::read(&p)).await?;
    if target.exists() {
        let receipt = safe_fs::read_regular(&target.join(".doxvelt/import.json"), true)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
        if body["archiveHash"] == snapshot.checksum
            && receipt
                .as_ref()
                .is_some_and(|v| v["archiveHash"] == snapshot.checksum && v["status"] == "imported")
        {
            return Ok(
                json!({"status":"current","summary":archive::summary(&snapshot,&target),"workspaceDir":target.to_string_lossy()}),
            );
        }
        return Err(invalid(
            "The destination folder already exists. Choose a new workspace folder.",
        ));
    }
    if action == "archive.preview-import" {
        for memory in &snapshot.memories {
            check(&cancel)?;
            let mut session =
                Session::open(&configuration, ":memory:", &memory.character_id, None).await?;
            let story = snapshot
                .stories
                .iter()
                .find(|s| s.simulation.simulation.id == memory.simulation_id)
                .unwrap();
            let version = array(&story.episode_memory, "publications")?
                .iter()
                .find(|v| v["id"] == memory.publication_id)
                .unwrap();
            let sources = archive::source_for(story, version)?;
            let source = sources
                .iter()
                .find(|s| s.character_id == memory.character_id)
                .unwrap();
            session.supply_source(string(version, "revision")?, source.observation.clone());
            let validation=async {
                let preview=session.request("previewImport",json!({"archive":memory.archive})).await?;
                session.request("importMemory",json!({"archive":memory.archive,"revision":preview["revision"],"archiveHash":preview["archiveHash"]})).await
            }.await;
            session.close().await;
            validation?;
        }
        return Ok(json!({"status":"ready","summary":archive::summary(&snapshot,&target)}));
    }
    if action != "archive.import" {
        return Err(invalid("Unknown workspace archive operation."));
    }
    if body["archiveHash"] != snapshot.checksum {
        return Err(invalid(
            "The archive changed after review. Preview the import again.",
        ));
    }
    let parent = target
        .parent()
        .ok_or_else(|| invalid("Choose a restored workspace with a parent directory."))?
        .to_path_buf();
    let a = snapshot.clone();
    let t = target.clone();
    let source = package.join("source");
    let stage = blocking(move || archive::stage_import(&parent, &t, &a, &source)).await?;
    let root = stage.path().join("workspace");
    for memory in &snapshot.memories {
        check(&cancel)?;
        let story = snapshot
            .stories
            .iter()
            .find(|s| s.simulation.simulation.id == memory.simulation_id)
            .unwrap();
        let version = array(&story.episode_memory, "publications")?
            .iter()
            .find(|v| v["id"] == memory.publication_id)
            .unwrap();
        let character = array(version, "characters")?
            .iter()
            .find(|c| c["characterId"] == memory.character_id)
            .unwrap();
        let sources = archive::source_for(story, version)?;
        let source = sources
            .iter()
            .find(|s| s.character_id == memory.character_id)
            .unwrap();
        let path = root
            .join(".doxvelt/memory")
            .join(string(character, "file")?);
        let mut session = Session::open(
            &configuration,
            &path.to_string_lossy(),
            &memory.character_id,
            None,
        )
        .await?;
        session.supply_source(string(version, "revision")?, source.observation.clone());
        let restored=async {
            let preview=session.request("previewImport",json!({"archive":memory.archive})).await?;
            session.request("importMemory",json!({"archive":memory.archive,"revision":preview["revision"],"archiveHash":preview["archiveHash"]})).await
        }.await;
        session.close().await;
        restored?;
    }
    // The exact reviewed archive and copied source must still be current. This
    // also catches source edits while the native memory callbacks were running.
    let p = package.clone();
    let reread = blocking(move || archive::read(&p)).await?;
    if reread.checksum != snapshot.checksum {
        return Err(invalid("Archive changed during import. Preview again."));
    }
    // Verify the authored bytes actually copied into the restored workspace.
    let staged_files = archive::restored_source_files(&root)?;
    if staged_files != snapshot.source_files {
        return Err(invalid(
            "Staged authored source does not match the archive.",
        ));
    }
    // Only compare authored files; generated .doxvelt data is staged separately.
    let source_stage = stage.path().join("verified-source");
    safe_fs::copy_verified(&package.join("source"), &source_stage)?;
    if archive::source_files(&source_stage)? != snapshot.source_files {
        return Err(invalid("Archive source changed during import."));
    }
    let receipt = json!({"archiveHash":snapshot.checksum,"status":"imported"});
    fs::write(
        root.join(".doxvelt/import.json"),
        serde_json::to_vec(&receipt).unwrap(),
    )
    .map_err(safe_fs::io)?;
    check(&cancel)?;
    safe_fs::publish_directory(&root, &target)?;
    Ok(
        json!({"status":"imported","summary":archive::summary(&snapshot,&target),"workspaceDir":target.to_string_lossy(),"next":"Open this folder as a DSH workspace. Choose available models in Models if needed."}),
    )
}
