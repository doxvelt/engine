//! Command-line application behavior. The Node launcher only transports arguments,
//! prints results and services credential-owned provider calls.
use crate::{
    application::{StartRequest, start_from_source},
    commands::{self, assert_expected_head, commit_effects, commit_manual_turn},
    content::{Asset, Entity, compile_workspace},
    context::{self, ContextOptions, inspect_actor_context},
    error::{EngineError, ErrorCode, Result},
    history,
    memory::{self, BeliefCandidate, ClosureGenerator, DeterministicClosureGenerator},
    model::Command,
    portable,
    projection::{BranchProjection, project_branch, string},
    source,
    storage::Store,
};
use serde_json::{Value, json};
use std::path::Path;

pub trait ModelClient {
    fn generate(&mut self, request: Value) -> Result<String>;
}
struct Args<'a>(&'a [String]);
impl Args<'_> {
    fn value(&self, key: &str) -> Option<&str> {
        self.0
            .iter()
            .position(|s| s == key)
            .and_then(|i| self.0.get(i + 1))
            .map(String::as_str)
    }
    fn required(&self, key: &str) -> Result<String> {
        self.value(key)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| EngineError::invalid(format!("{key} is required.")))
    }
    fn flag(&self, key: &str) -> bool {
        self.0.iter().any(|s| s == key)
    }
    fn positional(&self) -> Vec<&str> {
        let mut result = vec![];
        let mut i = 0;
        while i < self.0.len() {
            let s = &self.0[i];
            if s.starts_with("--") {
                if !["--json", "--ai"].contains(&s.as_str()) {
                    i += 1;
                }
            } else {
                result.push(s.as_str());
            }
            i += 1;
        }
        result
    }
    fn first(&self, label: &str) -> Result<String> {
        self.positional()
            .first()
            .map(|s| s.to_string())
            .ok_or_else(|| EngineError::invalid(format!("{label} is required.")))
    }
    fn owner(&self) -> &str {
        self.value("--owner").unwrap_or("local")
    }
    fn simulation(&self) -> &str {
        self.value("--simulation").unwrap_or("default")
    }
    fn database(&self) -> &str {
        self.value("--db").unwrap_or(".doxvelt/runtime.sqlite")
    }
    fn command(&self) -> Result<Command> {
        Ok(Command {
            owner_scope: self.owner().into(),
            simulation_id: self.simulation().into(),
            branch_id: self.required("--branch")?,
            expected_head: self.required("--expected-head")?,
            command_id: self.required("--command")?,
            payload: Value::Null,
        })
    }
    fn branch(&self, store: &Store) -> Result<String> {
        Ok(self
            .value("--branch")
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or(
                store
                    .simulation(self.owner(), self.simulation())?
                    .ok_or_else(|| EngineError {
                        code: ErrorCode::NotFound,
                        message: format!("Simulation not found: {}", self.simulation()),
                    })?
                    .default_branch_id,
            ))
    }
    fn projection(&self, store: &Store) -> Result<BranchProjection> {
        project_branch(
            store,
            self.owner(),
            self.simulation(),
            &self.branch(store)?,
            self.value("--head").filter(|s| !s.is_empty()),
        )
    }
    fn audience(&self) -> Option<Vec<String>> {
        self.value("--audience").map(csv)
    }
}
fn csv(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
fn active(p: &BranchProjection) -> Vec<String> {
    p.audience
        .iter()
        .filter(|a| a["status"] == "active")
        .filter_map(|a| a["actorId"].as_str().map(str::to_owned))
        .collect()
}
fn model(args: &Args, store: &Store) -> Result<Asset> {
    let id = args.required("--model")?;
    let sim = store
        .simulation(args.owner(), args.simulation())?
        .ok_or_else(|| EngineError::invalid("Simulation not found."))?;
    // Explicit legacy CLI model selection. Only the provider host resolves an
    // environment credential reference; literal credential fields are stripped.
    compile_workspace(Path::new(&sim.source_root))?
        .portable()
        .models
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| EngineError::invalid(format!("Model not found: {id}")))
}
struct ModelClosure<'a, T: ModelClient> {
    model: Asset,
    client: &'a mut T,
}
impl<T: ModelClient> ClosureGenerator for ModelClosure<'_, T> {
    fn write_memory(
        &mut self,
        actor: &Entity,
        context: &Value,
        _turns: &[Value],
        _label: Option<&str>,
    ) -> Result<String> {
        self.client.generate(json!({"actorId":actor.id,"purpose":"memory","model":self.model,"prompt":context["promptPreview"]}))
    }
    fn extract_beliefs(
        &mut self,
        _actor: &Entity,
        _context: &Value,
        memory: &Value,
    ) -> Result<Vec<BeliefCandidate>> {
        Ok(vec![BeliefCandidate {
            strength: 1.0,
            proposition: format!(
                "@{} treats this episode as meaningful.",
                string(memory, "actorId")?
            ),
        }])
    }
}
pub fn execute(arguments: &[String], models: &mut impl ModelClient) -> Result<Value> {
    let Some((name, remaining)) = arguments.split_first() else {
        return Ok(help());
    };
    if ["help", "--help", "-h"].contains(&name.as_str()) {
        return Ok(help());
    }
    let args = Args(remaining);
    match name.as_str() {
        "init" => {
            return source::init(
                Path::new(
                    args.positional()
                        .first()
                        .copied()
                        .unwrap_or("workspaces/demo"),
                ),
                args.value("--template"),
            );
        }
        "compile" => {
            return Ok(json!(compile_workspace(Path::new(
                args.positional()
                    .first()
                    .copied()
                    .unwrap_or("workspaces/demo")
            ))?));
        }
        "export" => {
            return portable::export_package(
                Path::new(args.database()),
                args.owner(),
                args.simulation(),
                Path::new(&args.first("target directory")?),
            );
        }
        "import" => {
            return portable::import_package(
                Path::new(&args.first("package directory")?),
                Path::new(&args.required("--world")?),
                Path::new(args.database()),
                None,
            );
        }
        _ => {}
    }
    if ![
        "start",
        "actors",
        "access",
        "audience",
        "whisper",
        "context",
        "turn",
        "draft",
        "edit",
        "regenerate",
        "fork",
        "transcript",
        "memories",
        "beliefs",
        "close-episode",
    ]
    .contains(&name.as_str())
    {
        return Err(EngineError::invalid(format!("Unknown command: {name}")));
    }
    let mut store = Store::open(Path::new(args.database()))?;
    if name == "start" {
        let started = start_from_source(
            &mut store,
            StartRequest {
                owner_scope: args.owner(),
                simulation_id: args.simulation(),
                command_id: &args.required("--command")?,
                scenario_id: Some(args.value("--scenario").unwrap_or("default").into()),
                branch_id: Some(args.value("--branch").unwrap_or("main").into()),
            },
            Path::new(
                args.positional()
                    .first()
                    .copied()
                    .unwrap_or("workspaces/demo"),
            ),
        )?;
        return Ok(
            json!({"message":"Started Doxvelt branch simulation.","simulationId":started.simulation.id,"scenarioId":started.simulation.scenario_id,"branch":started.branch,"head":started.root.id,"contentRevisionId":started.content_revision.id,"actors":started.content_revision.compiled.entities.iter().filter(|a|a.kind.can_own_turn()).map(|a|&a.id).collect::<Vec<_>>()}),
        );
    }
    if name == "actors" {
        let compiled = commands::compiled(&store, args.owner(), args.simulation())?;
        return Ok(
            json!({"simulationId":args.simulation(),"actors":compiled.entities.into_iter().filter(|a|a.kind.can_own_turn()).collect::<Vec<_>>()}),
        );
    }
    if name == "access" || name == "audience" {
        let positional = args.positional();
        let action = positional.first().copied().unwrap_or("list");
        let mut result = json!({"simulationId":args.simulation()});
        if action != "list" {
            let valid = if name == "access" {
                ["grant", "revoke"].contains(&action) && positional.len() >= 3
            } else {
                ["add", "remove", "deactivate", "reactivate"].contains(&action)
                    && positional.len() >= 2
            };
            if !valid {
                return Err(EngineError::invalid(if name == "access" {
                    "Usage: access (grant|revoke|list) [member] [container]"
                } else {
                    "Usage: audience (add|remove|deactivate|reactivate|list) [actor]"
                }));
            }
            let mut command = args.command()?;
            command.payload = if name == "access" {
                json!({"accessChanges":[{"action":action,"member":positional[1],"container":positional[2],"reason":args.value("--reason")} ]})
            } else {
                json!({"audienceChanges":[{"actorId":positional[1],"action":action,"reason":args.value("--reason")} ]})
            };
            result = json!(commit_effects(&mut store, command)?);
            result["message"] = json!(format!("Recorded {name} {action}."));
        }
        let p = args.projection(&store)?;
        if action == "list" {
            result["branch"] = json!(p.branch);
            result[if name == "access" {
                "accessEvents"
            } else {
                "audienceEvents"
            }] = json!(
                p.commits
                    .iter()
                    .flat_map(|c| c.events.iter())
                    .filter(|e| e["type"] == format!("{name}_changed"))
                    .collect::<Vec<_>>()
            );
        }
        if name == "access" {
            result["effectiveAccessLinks"] = json!(p.access_links);
        } else {
            result["activeAudience"] = json!(active(&p));
            result["audienceMembers"] = json!(p.audience);
        }
        return Ok(result);
    }
    if name == "whisper" {
        let actor = args.first("whisper actor")?;
        let command = args.command()?;
        if actor == "list" {
            return Ok(
                json!({"stageWhispers":store.pending_whispers(args.owner(),args.simulation(),&command.branch_id,&command.expected_head,&args.required("--actor")?)?}),
            );
        }
        let whisper = commands::stage_whisper(
            &mut store,
            json!({"ownerScope":command.owner_scope,"simulationId":command.simulation_id,"branchId":command.branch_id,"expectedHead":command.expected_head,"commandId":command.command_id,"targetActorId":actor,"text":args.required("--text")?}),
        )?;
        return Ok(
            json!({"message":format!("Staged private direction for @{actor}."),"whisper":whisper}),
        );
    }
    if name == "context" || name == "draft" {
        let actor = args.first(&format!("{name} actor"))?;
        let branch = args.branch(&store)?;
        let head = if name == "draft" {
            let command = Command {
                owner_scope: args.owner().into(),
                simulation_id: args.simulation().into(),
                branch_id: args.required("--branch")?,
                expected_head: args.required("--expected-head")?,
                command_id: "cli-preview".into(),
                payload: Value::Null,
            };
            assert_expected_head(&store, &command)?;
            command.expected_head
        } else {
            args.value("--head")
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .unwrap_or(
                    store
                        .branch(args.owner(), args.simulation(), &branch)?
                        .ok_or_else(|| EngineError::invalid("Branch not found."))?
                        .head_commit_id,
                )
        };
        let mut whispers =
            store.pending_whispers(args.owner(), args.simulation(), &branch, &head, &actor)?;
        if name == "draft"
            && let Some(text) = args.value("--whisper").filter(|s| !s.is_empty())
        {
            whispers.push(json!({"id":"draft-inline","ownerScope":args.owner(),"simulationId":args.simulation(),"branchId":branch,"expectedHead":head,"commandId":"draft-inline","targetActorId":actor,"text":text,"createdAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)}));
        }
        let audience = if name == "draft" {
            Some(args.audience().unwrap_or(active(&project_branch(
                &store,
                args.owner(),
                args.simulation(),
                &branch,
                Some(&head),
            )?)))
        } else {
            None
        };
        let context = inspect_actor_context(
            &store,
            args.owner(),
            args.simulation(),
            &branch,
            Some(&head),
            &actor,
            ContextOptions {
                audience: audience.as_deref(),
                whispers: &whispers,
                ..Default::default()
            },
        )?;
        if name == "context" {
            return Ok(context);
        }
        let text=models.generate(json!({"actorId":actor,"purpose":"turn","model":model(&args,&store)?,"prompt":context["promptPreview"]}))?;
        return Ok(
            json!({"simulationId":args.simulation(),"branchId":branch,"head":head,"actorId":actor,"modelId":args.required("--model")?,"text":text.trim(),"stageWhisperIds":whispers.iter().filter(|w|w["id"]!="draft-inline").map(|w|&w["id"]).collect::<Vec<_>>(),"context":context}),
        );
    }
    if name == "turn" {
        if args.flag("--ai") {
            return Err(EngineError::invalid(
                "Model output must be generated with draft and accepted separately with turn --manual.",
            ));
        }
        let actor = args.first("turn actor")?;
        let mut command = args.command()?;
        let syntax = args.value("--audience-syntax");
        let audience = if let Some(a) = args.audience() {
            Some(a)
        } else if syntax.is_some() {
            None
        } else {
            assert_expected_head(&store, &command)?;
            Some(active(&project_branch(
                &store,
                args.owner(),
                args.simulation(),
                &command.branch_id,
                Some(&command.expected_head),
            )?))
        };
        command.payload = json!({"actorId":actor,"text":args.required("--manual")?,"audience":audience,"stageWhisper":args.value("--whisper").filter(|s|!s.is_empty())});
        if let Some(syntax) = syntax {
            command.payload["audienceSyntax"] = json!(syntax);
            command.payload["knowledgePolicy"] = json!(commands::KNOWLEDGE_POLICY);
        }
        if args.flag("--whisper-ids") {
            command.payload["stageWhisperIds"] =
                json!(args.value("--whisper-ids").map(csv).unwrap_or_default());
        }
        let accepted = commit_manual_turn(&mut store, command)?;
        let p = args.projection(&store)?;
        let turn = p
            .transcript
            .iter()
            .find(|t| t["commitId"] == accepted.commit.id);
        return Ok(
            json!({"message":"Committed manual turn.","turn":turn,"commit":accepted.commit,"consumedStageWhispers":accepted.commit.events.iter().filter(|e|e["type"]=="stage_whisper_consumed").collect::<Vec<_>>()}),
        );
    }
    if name == "edit" || name == "regenerate" || name == "fork" {
        let command = args.command()?;
        let mut request = json!({"ownerScope":args.owner(),"simulationId":args.simulation(),"sourceBranchId":command.branch_id,"expectedHead":command.expected_head,"commandId":command.command_id,"branchId":args.required("--new-branch")?});
        return if name == "fork" {
            request["atCommitId"] = json!(args.required("--at")?);
            request["name"] = json!(args.value("--name").filter(|s| !s.is_empty()));
            Ok(json!(history::fork_branch(&mut store, request)?))
        } else {
            request["sourceCommitId"] = json!(args.required("--source-commit")?);
            request["payload"] = json!({"actorId":args.first(&format!("{name} actor"))?,"text":args.required("--manual")?,"audience":args.audience().unwrap_or_default()});
            Ok(json!(history::replace_turn(
                &mut store,
                request,
                name == "regenerate"
            )?))
        };
    }
    if name == "close-episode" {
        let mut command = args.command()?;
        command.payload = json!({"label":args.value("--label").filter(|s|!s.is_empty())});
        let configured = if args.flag("--ai") {
            Some(model(&args, &store)?)
        } else {
            None
        };
        let requested = memory::request_episode_closure(&mut store, command)?;
        let id = string(&requested["job"], "id")?;
        let result = if let Some(model) = configured {
            memory::run_memory_job(
                &mut store,
                args.owner(),
                args.simulation(),
                id,
                &mut ModelClosure {
                    model,
                    client: models,
                },
            )?
        } else {
            memory::run_memory_job(
                &mut store,
                args.owner(),
                args.simulation(),
                id,
                &mut DeterministicClosureGenerator,
            )?
        };
        let mut closed = result["closure"].clone();
        closed["commit"] = requested["commit"].clone();
        closed["message"] = json!(format!(
            "Closed {} episode.",
            if args.flag("--ai") {
                "AI"
            } else {
                "deterministic"
            }
        ));
        return Ok(closed);
    }
    let p = args.projection(&store)?;
    if name == "transcript" {
        return Ok(
            json!({"simulationId":args.simulation(),"branch":p.branch,"transcript":p.transcript}),
        );
    }
    if name == "memories" {
        return Ok(
            json!({"simulationId":args.simulation(),"branch":p.branch,"memories":p.episode_memories,"longTermMemories":p.long_term_memories}),
        );
    }
    let Some(actor) = args.positional().first().copied().map(str::to_owned) else {
        return Ok(json!({"simulationId":args.simulation(),"branch":p.branch,"beliefs":p.beliefs}));
    };
    let resolution = context::resolve_current_beliefs(&context::resolve_belief_access(
        &actor,
        &p.beliefs,
        &p.access_links,
    )?)?;
    Ok(
        json!({"simulationId":args.simulation(),"branch":p.branch,"actorId":actor,"currentBeliefs":resolution["current"],"conflictingBeliefs":resolution["conflicting"],"supersededBeliefs":resolution["superseded"],"groups":resolution["groups"]}),
    )
}
fn help() -> Value {
    json!(["Doxvelt native branch-aware runtime","Commands: init compile start export import actors access audience whisper context","turn draft edit regenerate fork transcript memories beliefs close-episode","All mutations require --command; branch mutations require --branch and --expected-head.","Turn/draft options: --whisper <text>; turn acceptance also supports --whisper-ids <ids>."].join("\n"))
}
