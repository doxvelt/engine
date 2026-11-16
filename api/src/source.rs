//! Local authored-source adapter. Compiled revisions remain immutable; these
//! edits change only the workspace from which a later revision may be compiled.
use crate::{
    content::compile_workspace,
    error::{EngineError, Result},
    identity::locale_compare,
    safe_fs::{self, io},
};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;
include!("templates.rs");

pub const FOLDERS: [&str; 6] = [
    "models",
    "worlds",
    "scenarios",
    "formats",
    "entities",
    "connections",
];
fn invalid(message: impl Into<String>) -> EngineError {
    EngineError::invalid(message)
}
pub fn list(workspace: &Path) -> Result<Value> {
    let root = safe_fs::absolute(workspace)?;
    let compiled = compile_workspace(&root)?;
    Ok(json!({"root":root.to_string_lossy(),"files":summaries(&compiled)}))
}
pub fn summaries(compiled: &crate::content::CompiledWorkspace) -> Vec<Value> {
    let mut files = Vec::new();
    for assets in [
        &compiled.models,
        &compiled.worlds,
        &compiled.scenarios,
        &compiled.formats,
        &compiled.connections,
    ] {
        for asset in assets {
            files.push(json!({"id":asset.id,"name":Path::new(&asset.path).file_name().unwrap_or_default().to_string_lossy(),"path":asset.path,"kind":asset.kind}));
        }
    }
    for entity in &compiled.entities {
        for file in &entity.files {
            let path = Path::new(file);
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            let section = path.file_stem().unwrap_or_default().to_string_lossy();
            files.push(json!({"id":format!("{}:{section}",entity.id),"name":name,"path":file,"kind":"entity-file","entityId":entity.id,"entityName":entity.name,"entityKind":entity.kind,"section":section}));
        }
    }
    files.sort_by(|a, b| locale_compare(a["path"].as_str().unwrap(), b["path"].as_str().unwrap()));
    files
}
fn resolve(root: &Path, relative: &str) -> Result<PathBuf> {
    let normalized = relative.replace('\\', "/");
    if !normalized
        .split('/')
        .next()
        .is_some_and(|s| FOLDERS.contains(&s))
    {
        return Err(invalid(format!(
            "Source path must start with one of: {}.",
            FOLDERS.join(", ")
        )));
    }
    let extension = Path::new(&normalized)
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    if !["md", "markdown", "yaml", "yml", "json"].contains(&extension.as_str()) {
        return Err(invalid(
            "Source path must be a Markdown, YAML, or JSON file.",
        ));
    }
    let target = safe_fs::absolute(&root.join(normalized))?;
    if target == root || !safe_fs::contained(root, &target) {
        return Err(invalid(
            "Source path must stay inside the workspace source folder.",
        ));
    }
    Ok(target)
}
fn root(workspace: &Path) -> Result<(PathBuf, PathBuf)> {
    let root = safe_fs::absolute(workspace)?;
    safe_fs::assert_no_symlink_components(&root)?;
    safe_fs::open_no_follow(&root, true)?;
    let real = fs::canonicalize(&root).map_err(io)?;
    Ok((root, real))
}
fn existing(target: &Path, trusted: &Path, allow_missing: bool) -> Result<()> {
    safe_fs::assert_no_symlink_components(target)?;
    match fs::canonicalize(target) {
        Ok(real) if safe_fs::contained(trusted, &real) => Ok(()),
        Ok(_) => Err(invalid("Workspace source path escapes the workspace.")),
        Err(e) if allow_missing && e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io(e)),
    }
}
fn parents(root: &Path, target: &Path, trusted: &Path) -> Result<()> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| invalid("Source directory is outside its workspace."))?;
    let mut current = root.to_owned();
    for part in relative.components() {
        current.push(part.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if safe_fs::symlink(&metadata) || !metadata.is_dir() => {
                return Err(invalid(
                    "Workspace source path contains an unsafe component.",
                ));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(io)?;
                safe_fs::open_no_follow(&current, true)?;
            }
            Err(e) => return Err(io(e)),
        }
        existing(&current, trusted, false)?;
    }
    Ok(())
}
fn result(root: &Path, target: &Path, text: &str) -> Value {
    json!({"root":root.to_string_lossy(),"path":target.strip_prefix(root).unwrap().to_string_lossy().replace('\\',"/"),"text":text})
}
pub fn read(workspace: &Path, relative: &str) -> Result<Value> {
    let (root, trusted) = root(workspace)?;
    let target = resolve(&root, relative)?;
    existing(&target, &trusted, false)?;
    let data = safe_fs::read_regular(&target, true)?;
    Ok(result(&root, &target, &String::from_utf8_lossy(&data)))
}
pub fn write(workspace: &Path, relative: &str, text: &str) -> Result<Value> {
    let (root, trusted) = root(workspace)?;
    let target = resolve(&root, relative)?;
    parents(&root, target.parent().unwrap(), &trusted)?;
    existing(&target, &trusted, true)?;
    safe_fs::write_private_regular(&target, text.as_bytes())?;
    Ok(result(&root, &target, text))
}
/// Reviewed publication compares the exact source text immediately before the
/// atomic replacement; a new file uses an exclusive link instead of overwrite.
pub fn publish(
    workspace: &Path,
    relative: &str,
    text: &str,
    expected: Option<&str>,
) -> Result<Value> {
    publish_checked(workspace, relative, text, expected, &|| Ok(()))
}
pub fn publish_checked(
    workspace: &Path,
    relative: &str,
    text: &str,
    expected: Option<&str>,
    check: &impl Fn() -> Result<()>,
) -> Result<Value> {
    let (root, trusted) = root(workspace)?;
    let target = resolve(&root, relative)?;
    parents(&root, target.parent().unwrap(), &trusted)?;
    existing(&target, &trusted, true)?;
    let temporary = target.parent().unwrap().join(format!(
        ".{}.{}.tmp",
        target.file_name().unwrap().to_string_lossy(),
        Uuid::new_v4()
    ));
    let operation = (|| {
        {
            let mut file = safe_fs::exclusive_file(&temporary)?;
            file.write_all(text.as_bytes()).map_err(io)?;
            file.sync_all().map_err(io)?;
        }
        let current = match fs::symlink_metadata(&target) {
            Ok(_) => Some(safe_fs::read_regular(&target, true)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(io(e)),
        };
        if current
            .as_ref()
            .map(|b| String::from_utf8_lossy(b))
            .as_deref()
            != expected
        {
            return Err(invalid(
                "Source changed before publication. Reopen it before saving.",
            ));
        }
        check()?;
        if expected.is_none() {
            fs::hard_link(&temporary, &target).map_err(io)?;
        } else {
            fs::rename(&temporary, &target).map_err(io)?;
        }
        Ok(result(&root, &target, text))
    })();
    let cleanup = fs::remove_file(&temporary);
    match (operation, cleanup) {
        (Err(error), _) => Err(error),
        (Ok(value), Ok(())) => Ok(value),
        (Ok(value), Err(e)) if e.kind() == std::io::ErrorKind::NotFound => Ok(value),
        (Ok(_), Err(e)) => Err(io(e)),
    }
}
pub fn delete(workspace: &Path) -> Result<Value> {
    let (root, _) = root(workspace)?;
    let missing: Vec<_> = FOLDERS
        .iter()
        .filter(|name| !root.join(name).is_dir())
        .copied()
        .collect();
    if !missing.is_empty() {
        return Err(invalid(format!(
            "Path does not look like a Doxvelt workspace. Missing folders: {}.",
            missing.join(", ")
        )));
    }
    let cwd = safe_fs::absolute(&std::env::current_dir().map_err(io)?)?;
    if root.parent().is_none() || safe_fs::contained(&cwd, &root) && safe_fs::contained(&root, &cwd)
    {
        return Err(invalid("Refusing to delete this workspace path."));
    }
    if safe_fs::contained(&cwd, &root) {
        let top = root.components().nth(cwd.components().count()).map(|p| {
            let name = p.as_os_str().to_string_lossy().into_owned();
            if cfg!(windows) {
                name.to_ascii_lowercase()
            } else {
                name
            }
        });
        if top.as_ref().is_some_and(|s| {
            [
                ".git",
                "design-system",
                "docs",
                "examples",
                "scripts",
                "src",
                "tests",
            ]
            .contains(&s.as_str())
        }) {
            return Err(invalid(format!(
                "Refusing to delete protected repository folder: {}.",
                top.unwrap()
            )));
        }
    }
    // The absolute target has been resolved and checked against its workspace
    // shape, filesystem root, process cwd and protected repository directories.
    fs::remove_dir_all(&root).map_err(io)?;
    Ok(json!({"root":root.to_string_lossy(),"deleted":true}))
}
pub fn init(workspace: &Path, template: Option<&str>) -> Result<Value> {
    let root = safe_fs::absolute(workspace)?;
    safe_fs::assert_no_symlink_components(&root)?;
    if let Some(template) = template.filter(|s| !s.is_empty()) {
        let files = TEMPLATES
            .iter()
            .find(|(name, _)| *name == template)
            .map(|(_, files)| *files)
            .ok_or_else(|| invalid(format!("Unknown Doxvelt init template: {template}")))?;
        fs::create_dir_all(&root).map_err(io)?;
        safe_fs::assert_no_symlink_components(&root)?;
        let trusted = fs::canonicalize(&root).map_err(io)?;
        for (relative, bytes) in files {
            let target = root.join(relative);
            parents(&root, target.parent().unwrap(), &trusted)?;
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(io)?
                .write_all(bytes)
                .map_err(io)?;
        }
    } else {
        fs::create_dir_all(&root).map_err(io)?;
        let trusted = fs::canonicalize(&root).map_err(io)?;
        for folder in FOLDERS {
            parents(&root, &root.join(folder), &trusted)?;
        }
        parents(&root, &root.join("entities/actor"), &trusted)?;
        for (path, text) in SEEDS {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(root.join(path))
                .map_err(io)?;
            file.write_all(text.as_bytes()).map_err(io)?;
        }
    }
    Ok(json!({"root":root.to_string_lossy()}))
}
const SEEDS: [(&str, &str); 7] = [
    (
        "models/local-openai-compatible.yaml",
        "---\nid: local-openai-compatible\nprovider: openai-compatible\nbase_url: http://localhost:11434/v1\nmodel: replace-with-model-name\napi_key_env: OLLAMA_API_KEY\n---\n",
    ),
    (
        "worlds/world.md",
        "---\nid: world\nname: New World\n---\n\nDescribe the objective laws, norms, genre rules, or training constraints for this world. :canonical\n",
    ),
    (
        "scenarios/scenario.md",
        "---\nid: scenario\nname: New Scenario\n---\n\nDescribe the objective starting situation for this simulation. :canonical\n",
    ),
    (
        "formats/default.md",
        "---\nid: default\nname: Default Format\n---\n\nDescribe how actors should answer during turns.\n",
    ),
    (
        "entities/actor/IDENTITY.md",
        "---\nid: actor\nkind: agent\nname: Actor\nvisibility: public\n---\n\n@actor is a participant in the simulation.\n",
    ),
    (
        "entities/actor/BELIEFS.md",
        "@actor treats this new simulation as ready for authoring. :+1\n",
    ),
    (
        "connections/README.md",
        "# Connections\n\nAdd connection files here when entities need relationships, memberships, access links, rivalries, ownership, or other authored links.\n",
    ),
];

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reviewed_publication_is_atomic_and_compares_exact_source_without_following_hardlinks() {
        let temp = safe_fs::TempDirectory::create(&std::env::temp_dir(), "doxvelt-native-source-")
            .unwrap();
        let root = temp.path().join("authored");
        init(&root, None).unwrap();
        let original = read(&root, "worlds/world.md").unwrap()["text"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(publish(&root, "worlds/world.md", "CHANGED", Some("stale")).is_err());
        assert_eq!(read(&root, "worlds/world.md").unwrap()["text"], original);
        publish(
            &root,
            "worlds/world.md",
            "  Exact replacement.\n",
            Some(&original),
        )
        .unwrap();
        assert_eq!(
            read(&root, "worlds/world.md").unwrap()["text"],
            "  Exact replacement.\n"
        );
        publish(&root, "worlds/new.md", "New source", None).unwrap();
        assert!(publish(&root, "worlds/new.md", "FORBIDDEN", None).is_err());
        let outside = temp.path().join("outside.md");
        fs::write(&outside, "PRIVATE").unwrap();
        fs::hard_link(&outside, root.join("worlds/linked.md")).unwrap();
        assert!(write(&root, "worlds/linked.md", "FORBIDDEN").is_err());
        assert!(publish(&root, "worlds/linked.md", "FORBIDDEN", Some("PRIVATE")).is_err());
        assert_eq!(fs::read_to_string(&outside).unwrap(), "PRIVATE");
        assert!(
            !fs::read_dir(root.join("worlds")).unwrap().any(|e| e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp"))
        );
    }
}
