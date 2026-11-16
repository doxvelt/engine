//! Local filesystem package adapter. Logical history is validated independently
//! of the host paths used to stage or publish the portable source and database.
use crate::{
    archive::{self, SimulationArchive, codec, verify::decode_archive},
    draft_contracts::exact,
    error::{EngineError, Result},
    identity::fingerprint,
    safe_fs::{self, DatabaseClaim, SourceClaim, TempDirectory, io},
    storage::Store,
};
use chrono::{SecondsFormat, Utc};
use regex::Regex;
use serde_json::{Value, json};
use std::{fs, io::Write, path::Path};

fn invalid(message: &str) -> EngineError {
    EngineError::invalid(message)
}
fn json_text(value: &impl serde::Serialize) -> Result<String> {
    serde_json::to_string_pretty(value)
        .map(|v| v + "\n")
        .map_err(|e| invalid(&e.to_string()))
}
fn read_json(path: &Path) -> Result<Value> {
    let bytes = fs::read(path).map_err(io)?;
    serde_json::from_str(&String::from_utf8_lossy(&bytes)).map_err(|e| invalid(&e.to_string()))
}
pub fn export_package(
    database: &Path,
    owner: &str,
    simulation: &str,
    target: &Path,
) -> Result<Value> {
    let archive = Store::open(database)?.export_simulation(owner, simulation)?;
    let old_root = archive.simulation.source_root.clone();
    let mut portable = archive.clone();
    rewrite_source_root(&mut portable, &old_root, "source")?;
    archive::validate(&portable)?;
    let runtime = json_text(&portable)?;
    if runtime.contains(&old_root) {
        return Err(invalid(
            "Portable simulation contains an absolute source path.",
        ));
    }
    let target = safe_fs::absolute(target)?;
    let manifest = json!({"doxveltVersion":"0.0.0","schemaVersion":archive.schema_version,"exportedAt":Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true),"ownerScope":owner,"simulationId":simulation,"scenarioId":portable.simulation.scenario_id,"sourceRootName":Path::new(&old_root).file_name().unwrap_or_default().to_string_lossy(),"files":{"source":"source","runtime":"simulation.json"}});
    fs::create_dir(&target).map_err(io)?;
    fs::create_dir(target.join("source")).map_err(io)?;
    copy_sanitized_directory(Path::new(&old_root), &target.join("source"))?;
    fs::write(target.join("simulation.json"), runtime).map_err(io)?;
    fs::write(target.join("manifest.json"), json_text(&manifest)?).map_err(io)?;
    Ok(json!({"manifest":manifest,"targetDir":target.to_string_lossy()}))
}
pub fn import_package(
    package: &Path,
    target_source: &Path,
    target_database: &Path,
    expected_owner: Option<&str>,
) -> Result<Value> {
    let package = safe_fs::absolute(package)?;
    safe_fs::open_no_follow(&package, true)
        .map_err(|_| invalid("Package path must be a real directory."))?;
    let manifest = read_json(&package.join("manifest.json"))?;
    validate_manifest(&manifest)?;
    let raw = read_json(&package.join("simulation.json"))?;
    if manifest["schemaVersion"] != raw["schemaVersion"]
        || manifest["ownerScope"] != raw["simulation"]["ownerScope"]
        || manifest["simulationId"] != raw["simulation"]["id"]
        || manifest["scenarioId"] != raw["simulation"]["scenarioId"]
    {
        return Err(invalid(
            "Imported package schema or identity does not match its runtime archive.",
        ));
    }
    let mut archive = archive::normalize(decode_archive(&raw)?)?;
    if expected_owner.is_some_and(|owner| archive.simulation.owner_scope != owner) {
        return Err(invalid(
            "Imported package owner scope does not match the trusted local scope.",
        ));
    }
    let source = safe_fs::absolute(target_source)?;
    let database = safe_fs::absolute(target_database)?;
    safe_fs::assert_no_symlink_components(&source)?;
    safe_fs::assert_no_symlink_components(&database)?;
    if safe_fs::contained(&source, &database) || safe_fs::contained(&database, &source) {
        return Err(invalid(
            "Import source and database targets must not overlap.",
        ));
    }
    if archive.simulation.source_root != "source" {
        return Err(invalid(
            "Imported simulation must use the logical package source reference.",
        ));
    }
    rewrite_source_root(&mut archive, "source", &source.to_string_lossy())?;
    archive::validate(&archive)?;
    safe_fs::absent(&source)?;
    safe_fs::absent(&database)?;
    let source_parent = source
        .parent()
        .ok_or_else(|| invalid("Import source parent is missing."))?;
    let database_parent = database
        .parent()
        .ok_or_else(|| invalid("Import database parent is missing."))?;
    fs::create_dir_all(source_parent).map_err(io)?;
    fs::create_dir_all(database_parent).map_err(io)?;
    let source_stage = TempDirectory::create(source_parent, ".import-source-")?;
    let database_stage = TempDirectory::create(database_parent, ".import-database-")?;
    let staged_source = source_stage.path().join("source");
    let staged_database = database_stage.path().join("runtime.sqlite");
    safe_fs::copy_verified(&package.join("source"), &staged_source)?;
    {
        let mut store = Store::open(&staged_database)?;
        store.import_simulation(archive)?;
    }
    publish_import_targets(&staged_source, &staged_database, &source, &database)?;
    Ok(
        json!({"manifest":manifest,"sourceRoot":source.to_string_lossy(),"dbPath":database.to_string_lossy()}),
    )
}
pub fn publish_import_targets(
    staged_source: &Path,
    staged_database: &Path,
    source: &Path,
    database: &Path,
) -> Result<()> {
    publish_with(staged_source, staged_database, source, database, || Ok(()))
}
fn publish_with(
    staged_source: &Path,
    staged_database: &Path,
    source: &Path,
    database: &Path,
    after_claims: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let source_claim = SourceClaim::create(source)?;
    let mut database_claim = match DatabaseClaim::create(database) {
        Ok(claim) => claim,
        Err(error) => {
            source_claim.cleanup();
            return Err(error);
        }
    };
    let result = (|| {
        after_claims()?;
        source_claim.assert_owned()?;
        safe_fs::copy_verified_directory(
            staged_source,
            source,
            &fs::canonicalize(staged_source).map_err(io)?,
            Some(&source_claim),
        )?;
        database_claim.write(&fs::read(staged_database).map_err(io)?)?;
        source_claim.finish()
    })();
    if result.is_err() {
        database_claim.cleanup();
        source_claim.cleanup();
    }
    result
}
pub fn rewrite_source_root(
    archive: &mut SimulationArchive,
    before: &str,
    after: &str,
) -> Result<()> {
    if archive.simulation.source_root != before {
        return Err(invalid("Simulation source reference is invalid."));
    }
    archive.simulation.source_root = after.into();
    if archive.content_revision.compiled.source_root == before {
        archive.content_revision.compiled.source_root = after.into();
    }
    for command in &mut archive.command_results {
        if command.canonical_input["kind"] == "start" {
            if command.canonical_input["sourceRoot"] != before {
                return Err(invalid("Start command source reference is invalid."));
            }
            command.canonical_input["sourceRoot"] = json!(after);
            if command.canonical_input["compiled"]["sourceRoot"] == before {
                command.canonical_input["compiled"]["sourceRoot"] = json!(after);
            }
        }
        if command.result["kind"] == "start" {
            if command.result["simulation"]["sourceRoot"] != before {
                return Err(invalid("Start outcome source reference is invalid."));
            }
            command.result["simulation"]["sourceRoot"] = json!(after);
            if command.result["contentRevision"]["compiled"]["sourceRoot"] == before {
                command.result["contentRevision"]["compiled"]["sourceRoot"] = json!(after);
            }
        }
        command.fingerprint = fingerprint(&command.canonical_input);
    }
    Ok(())
}
fn validate_manifest(value: &Value) -> Result<()> {
    exact(
        value,
        &[
            "doxveltVersion",
            "schemaVersion",
            "exportedAt",
            "ownerScope",
            "simulationId",
            "scenarioId",
            "sourceRootName",
            "files",
        ],
        &[],
        "Package manifest",
    )?;
    codec::strings(
        value,
        &[
            "doxveltVersion",
            "exportedAt",
            "ownerScope",
            "simulationId",
            "sourceRootName",
        ],
    )?;
    codec::nullable_text(&value["scenarioId"], "scenarioId")?;
    exact(
        &value["files"],
        &["source", "runtime"],
        &[],
        "Package layout",
    )?;
    if !value["schemaVersion"]
        .as_u64()
        .is_some_and(|v| [4, 5, 6, 7].contains(&v))
        || value["files"]["source"] != "source"
        || value["files"]["runtime"] != "simulation.json"
    {
        return Err(invalid(
            "Unsupported Doxvelt package schema or file layout.",
        ));
    }
    Ok(())
}
fn copy_sanitized_directory(source: &Path, target: &Path) -> Result<()> {
    let redaction = Regex::new(r"(?im)^(\s*api[_-]?key\s*:\s*).+$").unwrap();
    for entry in fs::read_dir(source).map_err(io)? {
        let entry = entry.map_err(io)?;
        let name = entry.file_name();
        let lower = name.to_string_lossy().to_lowercase();
        if [".doxvelt", ".dsh", ".git"].contains(&lower.as_str())
            || lower == ".env"
            || lower.starts_with(".env.")
            || lower.ends_with(".key")
            || lower.ends_with(".pem")
        {
            continue;
        }
        let source = entry.path();
        let target = target.join(name);
        let metadata = fs::symlink_metadata(&source).map_err(io)?;
        if safe_fs::symlink(&metadata) {
            continue;
        }
        if metadata.is_dir() {
            fs::create_dir(&target).map_err(io)?;
            copy_sanitized_directory(&source, &target)?;
        } else if metadata.is_file() {
            if [".md", ".markdown", ".yaml", ".yml", ".json", ".txt"]
                .iter()
                .any(|suffix| lower.ends_with(suffix))
            {
                let bytes = safe_fs::read_regular(&source, false)?;
                let data = redaction
                    .replace_all(&String::from_utf8_lossy(&bytes), "$1[redacted]")
                    .into_owned()
                    .into_bytes();
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&target)
                    .map_err(io)?
                    .write_all(&data)
                    .map_err(io)?;
            } else {
                safe_fs::copy_export_regular(&source, &target)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        application::{StartRequest, start_from_source},
        commands::commit_manual_turn,
        model::Command,
    };
    fn temporary() -> TempDirectory {
        TempDirectory::create(&std::env::temp_dir(), "doxvelt-native-package-").unwrap()
    }
    fn staged(root: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
        let source = root.join("staged-source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("story.md"), "Accepted source").unwrap();
        let db = root.join("staged.sqlite");
        fs::write(&db, "Accepted database").unwrap();
        (source, db)
    }
    #[test]
    fn native_packages_redact_credentials_rebind_sources_and_replay_after_import() {
        let temp = temporary();
        let root = temp.path();
        let source = root.join("authored");
        safe_fs::copy_verified(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/executive-interviews"),
            &source,
        )
        .unwrap();
        fs::write(source.join(".env"), "PRIVATE_ENV").unwrap();
        fs::write(source.join("private.pem"), "PRIVATE_KEY").unwrap();
        for directory in [".doxvelt", ".dsh", ".git"] {
            fs::create_dir(source.join(directory)).unwrap();
            fs::write(
                source.join(directory).join("runtime.sqlite"),
                "HOST_RUNTIME_STATE",
            )
            .unwrap();
        }
        fs::write(
            source.join("notes.txt"),
            "api_key: PRIVATE_CREDENTIAL\nordinary: content\n",
        )
        .unwrap();
        let db = root.join("story.sqlite");
        let mut store = Store::open(&db).unwrap();
        let start = start_from_source(
            &mut store,
            StartRequest {
                owner_scope: "local",
                simulation_id: "story",
                command_id: "start",
                scenario_id: Some("executive-interviews".into()),
                branch_id: Some("main".into()),
            },
            &source,
        )
        .unwrap();
        let command = Command {
            owner_scope: "local".into(),
            simulation_id: "story".into(),
            branch_id: "main".into(),
            expected_head: start.root.id,
            command_id: "turn".into(),
            payload: json!({"actorId":"ceo","text":"Keep this turn.","audience":["cfo"]}),
        };
        let accepted = commit_manual_turn(&mut store, command.clone()).unwrap();
        drop(store);
        let package = root.join("package");
        export_package(&db, "local", "story", &package).unwrap();
        assert!(!package.join("source/.env").exists());
        assert!(!package.join("source/private.pem").exists());
        for directory in [".doxvelt", ".dsh", ".git"] {
            assert!(!package.join("source").join(directory).exists());
        }
        assert_eq!(
            fs::read_to_string(package.join("source/notes.txt")).unwrap(),
            "api_key: [redacted]\nordinary: content\n"
        );
        let imported_source = root.join("imported-source");
        let imported_db = root.join("imported.sqlite");
        import_package(&package, &imported_source, &imported_db, Some("local")).unwrap();
        let mut imported = Store::open(&imported_db).unwrap();
        let replay = commit_manual_turn(&mut imported, command).unwrap();
        assert!(replay.replayed);
        assert_eq!(replay.commit, accepted.commit);
        assert_eq!(
            imported
                .simulation("local", "story")
                .unwrap()
                .unwrap()
                .source_root,
            imported_source.to_string_lossy()
        );
        let archive = imported.export_simulation("local", "story").unwrap();
        archive::validate(&archive).unwrap();
        drop(imported);
        assert!(import_package(&package, &imported_source, &imported_db, Some("local")).is_err());
        assert!(
            import_package(
                &package,
                &root.join("overlap"),
                &root.join("overlap/db.sqlite"),
                Some("local")
            )
            .is_err()
        );
        assert!(!root.join("overlap").exists());
        assert!(
            import_package(
                &package,
                &root.join("other-owner"),
                &root.join("other-owner.sqlite"),
                Some("other")
            )
            .is_err()
        );
        let outside = root.join("outside.md");
        fs::write(&outside, "PRIVATE_EXTERNAL").unwrap();
        fs::hard_link(&outside, package.join("source/hardlink.md")).unwrap();
        let rejected_source = root.join("hardlink-source");
        let rejected_db = root.join("hardlink.sqlite");
        assert!(import_package(&package, &rejected_source, &rejected_db, Some("local")).is_err());
        assert!(!rejected_source.exists());
        assert!(!rejected_db.exists());
        assert_eq!(fs::read_to_string(outside).unwrap(), "PRIVATE_EXTERNAL");
    }
    #[test]
    fn publication_never_overwrites_preexisting_targets() {
        let temp = temporary();
        let root = temp.path();
        let (staged_source, staged_db) = staged(root);
        let target_source = root.join("source");
        let target_db = root.join("target.sqlite");
        fs::write(&target_db, "FOREIGN DATABASE").unwrap();
        assert!(
            publish_import_targets(&staged_source, &staged_db, &target_source, &target_db).is_err()
        );
        assert!(!target_source.exists());
        assert_eq!(fs::read_to_string(&target_db).unwrap(), "FOREIGN DATABASE");
        fs::create_dir(&target_source).unwrap();
        fs::write(target_source.join("foreign.md"), "FOREIGN SOURCE").unwrap();
        assert!(
            publish_import_targets(&staged_source, &staged_db, &target_source, &target_db).is_err()
        );
        assert_eq!(
            fs::read_to_string(target_source.join("foreign.md")).unwrap(),
            "FOREIGN SOURCE"
        );
    }
    #[test]
    fn publication_cleans_its_renamed_claim_and_preserves_a_replacement_directory() {
        let temp = temporary();
        let root = temp.path();
        let (staged_source, staged_db) = staged(root);
        let target = root.join("source");
        let db = root.join("target.sqlite");
        let moved = root.join("moved-claim");
        let result = publish_with(&staged_source, &staged_db, &target, &db, || {
            fs::rename(&target, &moved).map_err(io)?;
            fs::create_dir(&target).map_err(io)?;
            fs::write(target.join("foreign.md"), "FOREIGN").map_err(io)
        });
        assert!(result.is_err());
        assert!(!moved.exists());
        assert!(!db.exists());
        assert_eq!(
            fs::read_to_string(target.join("foreign.md")).unwrap(),
            "FOREIGN"
        );
    }
    #[test]
    fn publication_preserves_a_replacement_database_after_losing_its_file_claim() {
        let temp = temporary();
        let root = temp.path();
        let (staged_source, staged_db) = staged(root);
        let target = root.join("source");
        let db = root.join("target.sqlite");
        let moved = root.join("moved.sqlite");
        let result = publish_with(&staged_source, &staged_db, &target, &db, || {
            fs::rename(&db, &moved).map_err(io)?;
            fs::write(&db, "FOREIGN DATABASE").map_err(io)
        });
        assert!(result.is_err());
        assert!(!target.exists());
        assert_eq!(fs::read_to_string(db).unwrap(), "FOREIGN DATABASE");
    }
}
