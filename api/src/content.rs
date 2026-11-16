use crate::error::{EngineError, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    sync::LazyLock,
};

pub type Metadata = Map<String, Value>;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntityKind {
    Agent,
    Affiliation,
    Artifact,
    Stateless,
}
impl EntityKind {
    pub fn can_own_turn(&self) -> bool {
        !matches!(self, Self::Artifact)
    }
    fn parse(value: &str) -> Option<Self> {
        match value {
            "agent" => Some(Self::Agent),
            "affiliation" => Some(Self::Affiliation),
            "artifact" => Some(Self::Artifact),
            "stateless" => Some(Self::Stateless),
            _ => None,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceSpan {
    pub file: String,
    pub line: usize,
    pub quote: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Asset {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub path: String,
    pub metadata: Metadata,
    pub body: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entity {
    pub id: String,
    pub kind: EntityKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_kind: Option<Value>,
    pub name: String,
    pub visibility: String,
    pub folder: String,
    pub files: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mention {
    pub id: String,
    pub source_span: SourceSpan,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaggedLine {
    pub tags: Vec<String>,
    pub mentions: Vec<String>,
    pub context: Value,
    pub source_span: SourceSpan,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Belief {
    pub holder: String,
    pub strength: i8,
    pub proposition_text: String,
    pub mentions: Vec<String>,
    pub source_span: SourceSpan,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Surface {
    pub entity: String,
    pub channels: Vec<String>,
    pub text: String,
    pub source_span: SourceSpan,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessLink {
    pub member: String,
    pub container: String,
    pub mode: String,
    pub source_span: SourceSpan,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Diagnostic {
    pub severity: String,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_spans: Option<Vec<SourceSpan>>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompiledWorkspace {
    pub source_root: String,
    pub models: Vec<Asset>,
    pub worlds: Vec<Asset>,
    pub scenarios: Vec<Asset>,
    pub formats: Vec<Asset>,
    pub entities: Vec<Entity>,
    pub connections: Vec<Asset>,
    pub mentions: Vec<Mention>,
    pub tagged_lines: Vec<TaggedLine>,
    pub beliefs: Vec<Belief>,
    pub surfaces: Vec<Surface>,
    pub access_links: Vec<AccessLink>,
    pub diagnostics: Vec<Diagnostic>,
}
impl CompiledWorkspace {
    pub fn portable(&self) -> Self {
        let mut compiled = self.clone();
        compiled.source_root.clear();
        for model in &mut compiled.models {
            model.metadata.retain(|key, _| {
                !matches!(
                    key.to_ascii_lowercase().as_str(),
                    "apikey" | "api_key" | "api-key"
                )
            });
        }
        compiled
    }
    pub fn require_valid(&self) -> Result<()> {
        if self.diagnostics.iter().any(|d| d.severity == "error") {
            Err(EngineError::invalid(format!(
                "Compiled workspace contains errors. {}",
                self.diagnostics
                    .iter()
                    .filter(|d| d.severity == "error")
                    .map(|d| d.message.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            )))
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Clone)]
struct SourceFile {
    id: String,
    path: String,
    name: String,
    data: Metadata,
    body: String,
    text: String,
    section: String,
}
static MENTIONS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"@([a-zA-Z0-9_-]+)").unwrap());
static TAGS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(^|\s):([a-zA-Z0-9_+@.-]+(?::[a-zA-Z0-9_+@.,-]+)?)").unwrap());
static ACCESS_TO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)access\s+to\b[\s\S]*?@([a-zA-Z0-9_-]+)").unwrap());
static SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
fn strength(tag: &str) -> Option<i8> {
    match tag {
        "+3" => Some(3),
        "+1" => Some(1),
        "0" => Some(0),
        "-1" => Some(-1),
        "-3" => Some(-3),
        _ => None,
    }
}
fn text_value(data: &Metadata, key: &str) -> Option<String> {
    data.get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}
fn value_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(value_string).collect::<Vec<_>>().join(","),
        _ => value.to_string(),
    }
}
fn unquote(value: &str) -> String {
    if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
        serde_json::from_str::<String>(value)
            .unwrap_or_else(|_| value[1..value.len() - 1].to_owned())
    } else if value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2 {
        value[1..value.len() - 1].to_owned()
    } else {
        value.to_owned()
    }
}
pub fn parse_frontmatter(text: &str) -> (Metadata, String) {
    if !text.starts_with("---\n") && !text.starts_with("---\r\n") {
        return (Metadata::new(), text.to_owned());
    }
    let normalized = text.replace("\r\n", "\n");
    let end = normalized[4..]
        .find("\n---\n")
        .map(|index| index + 4)
        .or_else(|| {
            normalized
                .ends_with("\n---")
                .then_some(normalized.len() - 4)
        });
    let Some(end) = end else {
        return (Metadata::new(), text.to_owned());
    };
    let raw = if end >= 4 { &normalized[4..end] } else { "" };
    let mut data = Metadata::new();
    for line in raw
        .trim()
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        let parsed = if value.starts_with('[') && value.ends_with(']') {
            let inner = value[1..value.len() - 1].trim();
            Value::Array(if inner.is_empty() {
                vec![]
            } else {
                inner
                    .split(',')
                    .map(|item| Value::String(unquote(item.trim())))
                    .collect()
            })
        } else {
            match value {
                "true" => Value::Bool(true),
                "false" => Value::Bool(false),
                "null" => Value::Null,
                _ => Value::String(unquote(value)),
            }
        };
        data.insert(key.trim().to_owned(), parsed);
    }
    let closing = if normalized[end..].starts_with("\n---\n") {
        5
    } else {
        4
    };
    (data, normalized[end + closing..].to_owned())
}
fn io_error(error: std::io::Error) -> EngineError {
    EngineError::invalid(error.to_string())
}
fn entries(path: &Path) -> Result<Vec<fs::DirEntry>> {
    let directory = match fs::read_dir(path) {
        Ok(directory) => directory,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(io_error(e)),
    };
    let mut entries = directory
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(io_error)?;
    entries.sort_by_key(|entry| entry.file_name());
    Ok(entries)
}
fn filename_id(name: &str) -> String {
    let path = Path::new(name);
    let extension = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ["md", "markdown", "yaml", "yml", "json"].contains(&extension.as_str()) {
        path.file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    } else {
        name.to_owned()
    }
}
fn read_file(root: &Path, path: &Path) -> Result<SourceFile> {
    crate::safe_fs::assert_no_symlink_components(path)?;
    let text = String::from_utf8_lossy(&crate::safe_fs::read_regular(path, true)?).into_owned();
    let (data, body) = parse_frontmatter(&text);
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let id = text_value(&data, "id").unwrap_or_else(|| filename_id(&name));
    Ok(SourceFile {
        id,
        path: path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/"),
        section: filename_id(&name),
        name,
        data,
        body,
        text,
    })
}
fn flat(
    root: &Path,
    folder: &str,
    kind: &str,
    sources: &mut BTreeMap<String, String>,
) -> Result<Vec<Asset>> {
    let mut result = Vec::new();
    for entry in entries(&root.join(folder))? {
        if !entry.file_type().map_err(io_error)?.is_file() {
            continue;
        }
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !["md", "markdown", "yaml", "yml", "json"].contains(&ext.as_str()) {
            continue;
        }
        let file = read_file(root, &path)?;
        sources.insert(file.path.clone(), file.text.clone());
        result.push(asset(file, kind));
    }
    Ok(result)
}
fn asset(file: SourceFile, kind: &str) -> Asset {
    Asset {
        name: text_value(&file.data, "name").unwrap_or_else(|| file.id.clone()),
        id: file.id,
        kind: kind.into(),
        path: file.path,
        metadata: file.data,
        body: file.body,
    }
}
fn title(id: &str) -> String {
    id.split(['-', '_'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            chars
                .next()
                .map(|c| c.to_uppercase().to_string() + chars.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}
pub fn compile_workspace(workspace: &Path) -> Result<CompiledWorkspace> {
    compile_workspace_with_sources(workspace).map(|(compiled, _)| compiled)
}
pub fn compile_workspace_with_sources(
    workspace: &Path,
) -> Result<(CompiledWorkspace, BTreeMap<String, String>)> {
    let absolute = std::path::absolute(workspace).map_err(io_error)?;
    let mut root = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                root.pop();
            }
            other => root.push(other.as_os_str()),
        }
    }
    let mut sources = BTreeMap::new();
    let mut compiled = CompiledWorkspace {
        source_root: root.to_string_lossy().into_owned(),
        models: flat(&root, "models", "model", &mut sources)?,
        worlds: flat(&root, "worlds", "world", &mut sources)?,
        scenarios: flat(&root, "scenarios", "scenario", &mut sources)?,
        formats: flat(&root, "formats", "format", &mut sources)?,
        connections: flat(&root, "connections", "connection", &mut sources)?,
        entities: vec![],
        mentions: vec![],
        tagged_lines: vec![],
        beliefs: vec![],
        surfaces: vec![],
        access_links: vec![],
        diagnostics: vec![],
    };
    for entry in entries(&root.join("entities"))? {
        if !entry.file_type().map_err(io_error)?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let mut files = Vec::new();
        for entry in entries(&entry.path())? {
            if !entry.file_type().map_err(io_error)?.is_file()
                || !entry
                    .path()
                    .extension()
                    .and_then(|v| v.to_str())
                    .is_some_and(|s| s.eq_ignore_ascii_case("md"))
            {
                continue;
            }
            let mut file = read_file(&root, &entry.path())?;
            sources.insert(file.path.clone(), file.text.clone());
            file.id = filename_id(&file.name);
            files.push(file);
        }
        let metadata = files
            .iter()
            .find(|file| file.name.eq_ignore_ascii_case("identity.md"))
            .map(|file| file.data.clone())
            .unwrap_or_default();
        let id = text_value(&metadata, "id").unwrap_or_else(|| name.clone());
        let entity = Entity {
            id: id.clone(),
            kind: metadata
                .get("kind")
                .and_then(Value::as_str)
                .and_then(EntityKind::parse)
                .unwrap_or(EntityKind::Agent),
            raw_kind: metadata.get("kind").cloned(),
            name: text_value(&metadata, "name").unwrap_or_else(|| title(&name)),
            visibility: text_value(&metadata, "visibility").unwrap_or_else(|| "public".into()),
            folder: format!("entities/{name}"),
            files: files.iter().map(|file| file.path.clone()).collect(),
        };
        compiled.entities.push(entity);
        for file in files {
            collect(
                &mut compiled,
                &file,
                json!({"holder":id,"section":file.section}),
            );
        }
    }
    for entry in entries(&root.join("connections"))? {
        if !entry.file_type().map_err(io_error)?.is_file() {
            continue;
        }
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !["md", "markdown", "yaml", "yml", "json"].contains(&ext.as_str()) {
            continue;
        }
        let file = read_file(&root, &path)?;
        if sources.get(&file.path) != Some(&file.text) {
            return Err(EngineError::invalid(
                "Source changed while compiling the collection.",
            ));
        }
        collect(&mut compiled, &file, json!({"connectionId":file.id}));
    }
    validate(&mut compiled);
    Ok((compiled, sources))
}
fn collect(records: &mut CompiledWorkspace, file: &SourceFile, context: Value) {
    let body = file.body.replace("\r\n", "\n");
    let text = file.text.replace("\r\n", "\n");
    let offset = if body.is_empty() {
        0
    } else {
        text.find(&body)
            .map(|index| text[..index].bytes().filter(|b| *b == b'\n').count())
            .unwrap_or(0)
    };
    for (index, line) in body.split('\n').enumerate() {
        let text = line.trim();
        if text.is_empty() || text.starts_with('#') {
            continue;
        }
        let mentions: Vec<String> = MENTIONS
            .captures_iter(text)
            .map(|c| c[1].to_owned())
            .collect();
        let tags: Vec<String> = TAGS.captures_iter(text).map(|c| c[2].to_owned()).collect();
        if mentions.is_empty() && tags.is_empty() {
            continue;
        }
        let span = SourceSpan {
            file: file.path.clone(),
            line: offset + index + 1,
            quote: text.into(),
        };
        for id in &mentions {
            records.mentions.push(Mention {
                id: id.clone(),
                source_span: span.clone(),
            });
        }
        if !tags.is_empty() {
            records.tagged_lines.push(TaggedLine {
                tags: tags.clone(),
                mentions: mentions.clone(),
                context: context.clone(),
                source_span: span.clone(),
            });
        }
        let prose = SPACE
            .replace_all(&TAGS.replace_all(text, ""), " ")
            .trim()
            .to_owned();
        if let Some(strength) = tags.iter().find_map(|tag| strength(tag)) {
            let holder = context
                .get("holder")
                .and_then(Value::as_str)
                .or_else(|| mentions.first().map(String::as_str))
                .or_else(|| context.get("connectionId").and_then(Value::as_str))
                .unwrap_or("unknown");
            records.beliefs.push(Belief {
                holder: holder.into(),
                strength,
                proposition_text: prose.clone(),
                mentions: mentions.clone(),
                source_span: span.clone(),
            });
        }
        if let Some(surface) = tags.iter().find_map(|tag| tag.strip_prefix("surface:")) {
            records.surfaces.push(Surface {
                entity: mentions
                    .first()
                    .map(String::as_str)
                    .or_else(|| context.get("holder").and_then(Value::as_str))
                    .unwrap_or("unknown")
                    .into(),
                channels: surface
                    .split(',')
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect(),
                text: prose,
                source_span: span.clone(),
            });
        }
        if tags.iter().any(|tag| tag == "access:member") {
            let before = text.to_ascii_lowercase().find("access").and_then(|index| {
                MENTIONS
                    .captures_iter(&text[..index])
                    .last()
                    .map(|c| c[1].to_owned())
            });
            let member = before
                .or_else(|| {
                    context
                        .get("holder")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .or_else(|| mentions.first().cloned())
                .unwrap_or_else(|| "unknown".into());
            let after = ACCESS_TO.captures(text).map(|c| c[1].to_owned());
            let peer = file
                .data
                .get("entities")
                .and_then(Value::as_array)
                .and_then(|ids| {
                    ids.iter()
                        .filter_map(Value::as_str)
                        .find(|id| *id != member)
                })
                .map(str::to_owned);
            let container = after
                .or(peer)
                .or_else(|| mentions.iter().find(|id| **id != member).cloned())
                .unwrap_or_else(|| "unknown".into());
            records.access_links.push(AccessLink {
                member,
                container,
                mode: "member".into(),
                source_span: span,
            });
        }
    }
}
fn diagnostic(code: &str, message: String, spans: Vec<SourceSpan>, error: bool) -> Diagnostic {
    Diagnostic {
        severity: if error { "error" } else { "warning" }.into(),
        code: code.into(),
        message,
        source_spans: Some(spans),
    }
}
fn validate(records: &mut CompiledWorkspace) {
    for model in &records.models {
        let span = SourceSpan {
            file: model.path.clone(),
            line: 1,
            quote: if model.body.is_empty() {
                model.path.clone()
            } else {
                model.body.clone()
            },
        };
        for (key, code) in [
            ("provider", "model_missing_provider"),
            ("model", "model_missing_model"),
        ] {
            if text_value(&model.metadata, key).is_none() {
                records.diagnostics.push(diagnostic(
                    code,
                    format!("Model {} is missing string {key} metadata.", model.id),
                    vec![span.clone()],
                    true,
                ));
            }
        }
        if text_value(&model.metadata, "provider").as_deref() == Some("openai-compatible") {
            match text_value(&model.metadata, "base_url") {
                None => records.diagnostics.push(diagnostic(
                    "model_missing_base_url",
                    format!(
                        "OpenAI-compatible model {} is missing string base_url metadata.",
                        model.id
                    ),
                    vec![span.clone()],
                    true,
                )),
                Some(value)
                    if !url::Url::parse(&value)
                        .is_ok_and(|url| ["http", "https"].contains(&url.scheme())) =>
                {
                    records.diagnostics.push(diagnostic(
                        "model_invalid_base_url",
                        format!(
                            "OpenAI-compatible model {} has invalid base_url metadata: {value}.",
                            model.id
                        ),
                        vec![span],
                        true,
                    ))
                }
                _ => {}
            }
        }
    }
    for entity in &records.entities {
        if let Some(raw) = &entity.raw_kind {
            if raw.as_str().and_then(EntityKind::parse).is_none() {
                let raw = value_string(raw);
                records.diagnostics.push(diagnostic(
                    "entity_invalid_kind",
                    format!("Entity {} has invalid kind metadata: {raw}.", entity.id),
                    vec![SourceSpan {
                        file: entity
                            .files
                            .iter()
                            .find(|f| f.ends_with("/IDENTITY.md"))
                            .cloned()
                            .unwrap_or_else(|| entity.folder.clone()),
                        line: 1,
                        quote: format!("kind: {raw}"),
                    }],
                    true,
                ));
            }
        }
    }
    let known: HashSet<&str> = records
        .entities
        .iter()
        .map(|e| e.id.as_str())
        .chain(
            [
                &records.models,
                &records.worlds,
                &records.scenarios,
                &records.formats,
            ]
            .into_iter()
            .flatten()
            .map(|a| a.id.as_str()),
        )
        .collect();
    let mut unresolved: Vec<(String, Vec<SourceSpan>)> = vec![];
    for mention in &records.mentions {
        if !known.contains(mention.id.as_str()) {
            if let Some((_, spans)) = unresolved.iter_mut().find(|(id, _)| id == &mention.id) {
                spans.push(mention.source_span.clone());
            } else {
                unresolved.push((mention.id.clone(), vec![mention.source_span.clone()]));
            }
        }
    }
    for (id, spans) in unresolved {
        records.diagnostics.push(diagnostic(
            "unresolved_mention",
            format!("Mention @{id} does not match a known entity or asset id."),
            spans,
            false,
        ));
    }
    let mut graph: BTreeMap<&str, Vec<&AccessLink>> = BTreeMap::new();
    for link in &records.access_links {
        graph.entry(&link.member).or_default().push(link);
        if link.member == link.container {
            records.diagnostics.push(diagnostic(
                "membership_self_loop",
                format!(
                    "Membership access link cannot make @{} a member of itself.",
                    link.member
                ),
                vec![link.source_span.clone()],
                true,
            ));
        }
    }
    let mut reported = HashSet::new();
    let mut errors = vec![];
    for link in &records.access_links {
        walk_cycles(
            &graph,
            &mut reported,
            vec![link.member.clone()],
            vec![],
            link,
            &mut errors,
        );
    }
    records.diagnostics.extend(errors);
}
fn walk_cycles(
    graph: &BTreeMap<&str, Vec<&AccessLink>>,
    reported: &mut HashSet<String>,
    mut path: Vec<String>,
    mut links: Vec<AccessLink>,
    link: &AccessLink,
    errors: &mut Vec<Diagnostic>,
) {
    let repeated = path.iter().position(|id| id == &link.container);
    path.push(link.container.clone());
    links.push(link.clone());
    if let Some(index) = repeated {
        let cycle = &path[index..];
        let nodes = &cycle[..cycle.len() - 1];
        let key = (0..nodes.len())
            .map(|i| {
                nodes[i..]
                    .iter()
                    .chain(nodes[..i].iter())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("->")
            })
            .min_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()))
            .unwrap_or_default();
        if reported.insert(key) {
            let cycle_links = &links[index..];
            errors.push(diagnostic(
                if cycle_links.len() == 1 {
                    "membership_self_loop"
                } else {
                    "membership_cycle"
                },
                format!(
                    "Membership access cycle is invalid: {}.",
                    cycle
                        .iter()
                        .map(|id| format!("@{id}"))
                        .collect::<Vec<_>>()
                        .join(" -> ")
                ),
                cycle_links
                    .iter()
                    .map(|link| link.source_span.clone())
                    .collect(),
                true,
            ));
        }
        return;
    }
    for next in graph.get(link.container.as_str()).into_iter().flatten() {
        walk_cycles(graph, reported, path.clone(), links.clone(), next, errors);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frontmatter_keeps_the_authored_simple_yaml_and_legacy_literal_rules() {
        let (data, body) = parse_frontmatter("---\r\nid: jade\r\nname: \"Jade \\");
        assert!(data.is_empty());
        assert!(body.starts_with("---"));
        let (data, body) = parse_frontmatter(
            "---\nid: jade\nentities: [jade, mafia]\nprivate: true\nvalue: null\npath: \"C:\\notes\"\n---\nText",
        );
        assert_eq!(data["entities"], json!(["jade", "mafia"]));
        assert_eq!(data["private"], true);
        assert_eq!(data["value"], Value::Null);
        assert_eq!(body, "Text");
        assert_eq!(parse_frontmatter("---\nid: actor\n---").0["id"], "actor");
    }
    #[test]
    fn shipped_sources_compile_with_tag_only_beliefs_and_source_spans() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/last-crossing");
        let compiled = compile_workspace(&root).unwrap();
        assert_eq!(compiled.entities.len(), 3);
        assert!(compiled.diagnostics.is_empty());
        assert!(!compiled.beliefs.is_empty());
        for belief in &compiled.beliefs {
            let source = fs::read_to_string(root.join(&belief.source_span.file)).unwrap();
            assert_eq!(
                source
                    .replace("\r\n", "\n")
                    .split('\n')
                    .nth(belief.source_span.line - 1)
                    .unwrap()
                    .trim(),
                belief.source_span.quote
            );
        }
        let portable = compiled.portable();
        assert_eq!(portable.source_root, "");
        assert!(!compiled.source_root.is_empty());
    }
}
