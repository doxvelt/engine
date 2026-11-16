//! Maintained episode-memory eligibility and publication catalog. This is
//! separate from the legacy deterministic closure-job compatibility seam.
use crate::{
    audience::project_turn,
    content::EntityKind,
    error::{EngineError, ErrorCode, Result},
    identity::{js_trim, locale_compare, sha256},
    ports::SimulationReader,
    projection::{project_branch, string},
};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EpisodeQuery {
    pub owner_scope: String,
    pub simulation_id: String,
    pub branch_id: String,
    pub head: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryConfiguration {
    pub directory: String,
    pub executable: String,
    pub model_key: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub character_id: String,
    pub name: String,
    pub observation: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scene {
    pub slot: String,
    pub label: String,
    pub date: Option<String>,
    pub revision: String,
    pub episode_id: Option<String>,
    pub sources: Vec<Source>,
}
#[derive(Clone, Debug)]
pub struct Formation {
    pub id: String,
    pub story: String,
    pub scene: Scene,
    pub prior: Vec<Value>,
    pub version: Value,
}
#[derive(Clone, Debug)]
pub enum FormationPlan {
    Current(Value),
    New(Formation),
}
#[derive(Clone, Debug)]
pub struct Recall {
    pub date: String,
    pub search: String,
    pub publications: Vec<Value>,
}
fn invalid(message: &str) -> EngineError {
    EngineError::invalid(message)
}
fn missing(message: &str) -> EngineError {
    EngineError {
        code: ErrorCode::NotFound,
        message: message.into(),
    }
}
fn sql(error: rusqlite::Error) -> EngineError {
    EngineError {
        code: ErrorCode::Internal,
        message: error.to_string(),
    }
}
pub fn json_hash(value: &Value) -> String {
    sha256(&serde_json::to_string(value).unwrap())
}
pub fn story(query: &EpisodeQuery) -> String {
    json_hash(&json!([query.owner_scope, query.simulation_id]))
}
pub fn require_date(date: &str) -> Result<()> {
    let bytes = date.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(i, c)| i != 4 && i != 7 && !c.is_ascii_digit())
        || chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err()
    {
        return Err(invalid("Enter a fictional date as YYYY-MM-DD."));
    }
    Ok(())
}
pub fn scenes(
    reader: &impl SimulationReader,
    query: &EpisodeQuery,
    dates: &HashMap<String, String>,
) -> Result<Vec<Scene>> {
    let p = project_branch(
        reader,
        &query.owner_scope,
        &query.simulation_id,
        &query.branch_id,
        query.head.as_deref(),
    )?;
    let sim = reader
        .simulation(&query.owner_scope, &query.simulation_id)?
        .ok_or_else(|| missing("Simulation not found."))?;
    let compiled = reader
        .revision(&query.owner_scope, &sim.content_revision_id)?
        .ok_or_else(|| missing("Content revision not found."))?
        .compiled;
    let label = |id: &str| {
        compiled
            .entities
            .iter()
            .find(|a| a.id == id)
            .filter(|a| a.visibility == "public")
            .map(|a| a.name.clone())
            .unwrap_or_else(|| id.into())
    };
    let mut perceptions: HashMap<&str, HashSet<&str>> = HashMap::new();
    for entry in &p.perceptions {
        perceptions
            .entry(string(entry, "actorId")?)
            .or_default()
            .insert(string(entry, "sourceMessageVersionId")?);
    }
    let episodes = p
        .episode_closures
        .iter()
        .map(|c| &c["episode"])
        .collect::<Vec<_>>();
    let mut result = Vec::new();
    for index in 0..=episodes.len() {
        let episode = episodes.get(index);
        let episode_id = episode.map(|e| e["id"].as_str().unwrap().to_owned());
        let slot = if index == 0 {
            "first".into()
        } else {
            string(episodes[index - 1], "id")?.into()
        };
        let date = dates.get(&slot).cloned();
        let turns = p
            .transcript
            .iter()
            .filter(|t| t["episodeId"].as_str() == episode_id.as_deref())
            .collect::<Vec<_>>();
        let name = episode
            .and_then(|e| e["label"].as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("Episode {}", index + 1));
        let mut sources = Vec::new();
        for actor in compiled
            .entities
            .iter()
            .filter(|a| a.kind == EntityKind::Agent)
        {
            let seen = perceptions.get(actor.id.as_str());
            let mut messages = Vec::new();
            for turn in &turns {
                let version = turn
                    .get("messageVersionId")
                    .filter(|v| !v.is_null())
                    .unwrap_or(&turn["id"]);
                if !seen.is_some_and(|seen| version.as_str().is_some_and(|id| seen.contains(id))) {
                    continue;
                }
                let Some(perceived) = project_turn(turn, &actor.id) else {
                    continue;
                };
                let mut record = Map::new();
                record.insert("speaker".into(), json!(label(string(turn, "actorId")?)));
                if turn.get("performance").is_none() {
                    record.insert(
                        "recipients".into(),
                        json!(
                            crate::projection::array(turn, "audience")?
                                .iter()
                                .filter_map(Value::as_str)
                                .filter(|id| *id != string(turn, "actorId").unwrap())
                                .map(label)
                                .collect::<Vec<_>>()
                        ),
                    );
                }
                record.insert("performance".into(), perceived["text"].clone());
                messages.push(json!({"id":version,"role":if turn["actorId"]==actor.id {"assistant"} else {"user"},"text":serde_json::to_string(&Value::Object(record)).unwrap()}));
            }
            if !messages.is_empty() {
                sources.push(Source {character_id:actor.id.clone(),name:actor.name.clone(),observation:json!({"foundation":format!("The remembering character is {}.",actor.name),"messages":messages})});
            }
        }
        let changed = turns.iter().any(|turn| {
            std::iter::once(&turn["actorId"])
                .chain(turn["audience"].as_array().into_iter().flatten())
                .any(|id| {
                    compiled
                        .entities
                        .iter()
                        .any(|a| a.id == *id && a.visibility != "public" && a.name != a.id)
                })
        });
        let mut identity = vec![
            json!(slot),
            json!(date),
            json!(sim.content_revision_id),
            json!(
                turns
                    .iter()
                    .map(|t| t
                        .get("bodyRevisionId")
                        .filter(|v| !v.is_null())
                        .or_else(|| t.get("messageVersionId").filter(|v| !v.is_null()))
                        .unwrap_or(&t["id"]))
                    .collect::<Vec<_>>()
            ),
        ];
        if changed {
            identity.push(json!("public-role-labels-v1"));
        }
        result.push(Scene {
            slot,
            label: name,
            date,
            revision: json_hash(&json!(identity)),
            episode_id,
            sources,
        });
    }
    Ok(result)
}
pub fn public_memory(version: Option<&Value>) -> Vec<Value> {
    version.and_then(|v|v["characters"].as_array()).map(|c|c.iter().map(|c|json!({"characterId":c["characterId"],"memories":c["memories"],"impressions":c["impressions"]})).collect()).unwrap_or_default()
}
pub fn resolve(scenes: &[Scene], publications: &[Value]) -> Vec<(String, Value)> {
    let mut eligible = HashSet::new();
    let mut selected = Vec::new();
    let mut dated = scenes
        .iter()
        .filter(|s| s.date.is_some())
        .collect::<Vec<_>>();
    dated.sort_by(|a, b| locale_compare(a.date.as_deref().unwrap(), b.date.as_deref().unwrap()));
    for scene in dated {
        if let Some(version) = publications.iter().find(|v| {
            v["revision"] == scene.revision
                && v["dependencies"]
                    .as_array()
                    .is_some_and(|deps| deps.iter().all(|id| eligible.contains(id)))
        }) {
            selected.push((scene.slot.clone(), version.clone()));
            eligible.insert(version["id"].clone());
        }
    }
    selected
}
pub fn earlier(scenes: &[Scene], publications: &[Value], active: &Scene) -> Vec<Value> {
    let Some(date) = active.date.as_ref() else {
        return Vec::new();
    };
    let before = scenes
        .iter()
        .filter(|s| s.date.as_ref().is_some_and(|d| d < date))
        .cloned()
        .collect::<Vec<_>>();
    resolve(&before, publications)
        .into_iter()
        .map(|(_, v)| v)
        .collect()
}
pub fn named_reflection(request: &Value, source: &Source, prior: &[Value]) -> Result<Value> {
    let mut previous = Vec::new();
    for version in prior {
        if let Some(character) = version["characters"].as_array().and_then(|chars| {
            chars
                .iter()
                .find(|c| c["characterId"] == source.character_id)
        }) {
            previous.push(json!({"episode":version["label"],"date":version["date"],"recollections":crate::projection::array(character,"memories")?.iter().map(|m|json!({"gist":m["gist"],"feeling":m["feeling"]})).collect::<Vec<_>>(),"impressions":crate::projection::array(character,"impressions")?.iter().map(|m|&m["text"]).collect::<Vec<_>>()}));
        }
    }
    let mut scoped = false;
    for message in crate::projection::array(&source.observation, "messages")? {
        let text: Value =
            serde_json::from_str(string(message, "text")?).map_err(|e| invalid(&e.to_string()))?;
        scoped |= text.get("recipients").is_none();
    }
    let mut lines = vec![
        "Form subjective long-term memories for the named remembering character. Write in first person and use the supplied labels for other characters.",
        if scoped {
            "Each played message contains a JSON record of the speaker and performance as perceived by the remembering character. Speech records a claim being made, not established truth. Host user and assistant labels distinguish other characters and self. The human may play any character."
        } else {
            "Each played message contains a JSON record of the speaker, recipients, and performance. Use those roles for attribution. An opaque handle is that character's supplied label. Host user and assistant labels distinguish other characters and self. The human may play any character."
        },
        "Earlier memories are background for interpretation. Source message and episode aliases belong to the current episode. Cite current evidence for each new memory or impression.",
    ];
    lines.extend(string(request, "system")?.split('\n').skip(3));
    Ok(
        json!({"system":lines.join("\n"),"input":{"nativeEpisode":request["input"],"earlierSubjectiveMemory":previous},"maxTokens":request["maxTokens"]}),
    )
}
pub struct EpisodeCatalog {
    connection: Connection,
    pub directory: PathBuf,
}
impl EpisodeCatalog {
    /// Cleanup uses a read-only catalog. If ownership cannot be established,
    /// callers preserve the database rather than risk deleting a publication.
    pub fn file_referenced(directory: &Path, file: &str) -> Result<bool> {
        let connection = Connection::open_with_flags(
            directory.join("catalog.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(sql)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(sql)?;
        connection.query_row("SELECT EXISTS(SELECT 1 FROM memory_versions, json_each(memory_versions.data,'$.characters') AS c WHERE json_extract(c.value,'$.file')=?)",[file],|r|r.get(0)).map_err(sql)
    }
    pub fn open(directory: &Path) -> Result<Self> {
        fs::create_dir_all(directory).map_err(crate::safe_fs::io)?;
        let connection = Connection::open(directory.join("catalog.sqlite")).map_err(sql)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(sql)?;
        connection.execute_batch("CREATE TABLE IF NOT EXISTS fictional_dates (story TEXT NOT NULL,slot TEXT NOT NULL,date TEXT NOT NULL,PRIMARY KEY(story,slot));CREATE TABLE IF NOT EXISTS memory_versions(id TEXT PRIMARY KEY,story TEXT NOT NULL,slot TEXT NOT NULL,data TEXT NOT NULL);CREATE INDEX IF NOT EXISTS memory_versions_story ON memory_versions(story)").map_err(sql)?;
        Ok(Self {
            connection,
            directory: directory.into(),
        })
    }
    pub fn scenes(
        &self,
        reader: &impl SimulationReader,
        query: &EpisodeQuery,
    ) -> Result<Vec<Scene>> {
        let dates = self
            .connection
            .prepare("SELECT slot,date FROM fictional_dates WHERE story=?")
            .map_err(sql)?
            .query_map([story(query)], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(sql)?
            .collect::<rusqlite::Result<HashMap<_, _>>>()
            .map_err(sql)?;
        scenes(reader, query, &dates)
    }
    pub fn publications(&self, query: &EpisodeQuery) -> Result<Vec<Value>> {
        self.connection
            .prepare("SELECT data FROM memory_versions WHERE story=? ORDER BY rowid DESC")
            .map_err(sql)?
            .query_map([story(query)], |r| {
                let text: String = r.get(0)?;
                serde_json::from_str(&text).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })
            })
            .map_err(sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql)
    }
    pub fn inspect(
        &self,
        reader: &impl SimulationReader,
        query: &EpisodeQuery,
    ) -> Result<Vec<Value>> {
        let scenes = self.scenes(reader, query)?;
        let publications = self.publications(query)?;
        let selected = resolve(&scenes, &publications);
        Ok(scenes.iter().map(|scene|{let version=selected.iter().find(|(slot,_)|slot==&scene.slot).map(|(_,v)|v);json!({"slot":scene.slot,"episodeId":scene.episode_id,"label":scene.label,"date":scene.date,"revision":scene.revision,"canMemorize":!scene.sources.is_empty(),"status":if version.is_some() {"current"} else if publications.iter().any(|v|v["slot"]==scene.slot) {"drifted"} else {"unmemorized"},"memories":public_memory(version)})}).collect())
    }
    pub fn set_date(
        &self,
        reader: &impl SimulationReader,
        query: &EpisodeQuery,
        slot: &str,
        date: &str,
    ) -> Result<Vec<Value>> {
        require_date(date)?;
        let scenes = self.scenes(reader, query)?;
        if !scenes.iter().any(|s| s.slot == slot) {
            return Err(missing("Episode is unavailable on this story path."));
        }
        if scenes
            .iter()
            .any(|s| s.slot != slot && s.date.as_deref() == Some(date))
        {
            return Err(invalid(
                "Each episode on this story path needs a different fictional date.",
            ));
        }
        self.connection.execute("INSERT INTO fictional_dates VALUES (?,?,?) ON CONFLICT(story,slot) DO UPDATE SET date=excluded.date",params![story(query),slot,date]).map_err(sql)?;
        self.inspect(reader, query)
    }
    pub fn prepare_memorize(
        &self,
        reader: &impl SimulationReader,
        query: &EpisodeQuery,
        slot: &str,
    ) -> Result<FormationPlan> {
        let scenes = self.scenes(reader, query)?;
        let scene = scenes
            .iter()
            .find(|s| s.slot == slot)
            .ok_or_else(|| missing("Episode is unavailable on this story path."))?
            .clone();
        if scene.date.is_none() {
            return Err(invalid(
                "Set the fictional date before memorizing this episode.",
            ));
        }
        if scene.sources.is_empty() {
            return Err(invalid("Play at least one turn before memorizing."));
        }
        let publications = self.publications(query)?;
        let actors: HashSet<_> = scene
            .sources
            .iter()
            .map(|s| s.character_id.as_str())
            .collect();
        let prior = earlier(&scenes, &publications, &scene)
            .into_iter()
            .filter(|v| {
                v["characters"].as_array().is_some_and(|chars| {
                    chars.iter().any(|c| {
                        c["characterId"]
                            .as_str()
                            .is_some_and(|id| actors.contains(id))
                            && ["memories", "impressions"]
                                .iter()
                                .any(|k| c[*k].as_array().is_some_and(|a| !a.is_empty()))
                    })
                })
            })
            .collect::<Vec<_>>();
        let dependencies = prior.iter().map(|v| v["id"].clone()).collect::<Vec<_>>();
        let story = story(query);
        let id = json_hash(&json!([story, scene.revision, dependencies]));
        if let Some(existing) = publications.iter().find(|v| v["id"] == id) {
            return Ok(FormationPlan::Current(
                json!({"status":"current","memories":public_memory(Some(existing))}),
            ));
        }
        let version = json!({"id":id,"slot":scene.slot,"revision":scene.revision,"date":scene.date,"label":scene.label,"dependencies":dependencies,"characters":[]});
        Ok(FormationPlan::New(Formation {
            id,
            story,
            scene,
            prior,
            version,
        }))
    }
    pub fn publish(&self, query: &EpisodeQuery, version: &Value) -> Result<(Value, bool)> {
        let inserted = self
            .connection
            .execute(
                "INSERT OR IGNORE INTO memory_versions VALUES (?,?,?,?)",
                params![
                    string(version, "id")?,
                    story(query),
                    string(version, "slot")?,
                    serde_json::to_string(version).unwrap()
                ],
            )
            .map_err(sql)?
            == 1;
        let saved = if inserted {
            version.clone()
        } else {
            self.publications(query)?
                .into_iter()
                .find(|v| v["id"] == version["id"])
                .ok_or_else(|| invalid("Memory publication disappeared."))?
        };
        Ok((
            json!({"status":if inserted {"published"} else {"current"},"memories":public_memory(Some(&saved))}),
            inserted,
        ))
    }
    pub fn prepare_recall(
        &self,
        reader: &impl SimulationReader,
        query: &EpisodeQuery,
        actor: &str,
        cue: &str,
    ) -> Result<Option<Recall>> {
        let scenes = self.scenes(reader, query)?;
        let active = scenes
            .last()
            .ok_or_else(|| invalid("Active episode is missing."))?;
        let Some(date) = active.date.as_ref() else {
            return Ok(None);
        };
        let recent = active
            .sources
            .iter()
            .find(|s| s.character_id == actor)
            .and_then(|s| s.observation["messages"].as_array())
            .map(|a| &a[a.len().saturating_sub(4)..])
            .unwrap_or_default();
        let mut texts = recent
            .iter()
            .map(|m| string(m, "text").map(str::to_owned))
            .collect::<Result<Vec<_>>>()?;
        texts.push(cue.into());
        let joined = js_trim(&texts.join("\n")).to_owned();
        // JS's 12,000-code-unit suffix is the wire compatibility bound. A cut
        // through a surrogate is represented by the normal UTF-8 replacement.
        let utf16 = joined.encode_utf16().collect::<Vec<_>>();
        let search = String::from_utf16_lossy(&utf16[utf16.len().saturating_sub(12_000)..]);
        Ok(Some(Recall {
            date: date.clone(),
            search,
            publications: earlier(&scenes, &self.publications(query)?, active),
        }))
    }
}
