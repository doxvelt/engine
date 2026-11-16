use super::*;
use crate::{draft_contracts, projection::string};

impl crate::ports::ActorDraftRepository for Store {
    fn replay_accepted_draft(&self, request: &AcceptRequest) -> Result<Option<Committed>> {
        Store::replay_accepted_draft(self, request)
    }
    fn commit_accepted_draft(
        &mut self,
        request: &AcceptRequest,
        command: &Value,
        created_at: &str,
    ) -> Result<Committed> {
        Store::commit_accepted_draft(self, request, command, created_at)
    }
    fn reserve_actor_draft(
        &mut self,
        draft: Value,
        command_fingerprint: &str,
    ) -> Result<(Value, bool)> {
        Store::reserve_actor_draft(self, draft, command_fingerprint)
    }
    fn transition_actor_draft(
        &mut self,
        owner: &str,
        simulation: &str,
        id: &str,
        artifact: Option<&Value>,
        failure: Option<&Value>,
    ) -> Result<Value> {
        Store::transition_actor_draft(self, owner, simulation, id, artifact, failure)
    }
    fn discard_actor_draft(
        &mut self,
        owner: &str,
        simulation: &str,
        id: &str,
        command: &str,
    ) -> Result<(Value, bool)> {
        Store::discard_actor_draft(self, owner, simulation, id, command)
    }
}
impl Store {
    pub fn replay_accepted_draft(&self, request: &AcceptRequest) -> Result<Option<Committed>> {
        assert_no_historical_command(
            &self.connection,
            &request.owner_scope,
            &request.simulation_id,
            &request.command_id,
        )?;
        let owner = &request.owner_scope;
        let simulation = &request.simulation_id;
        let id = &request.command_id;
        let collision=self.connection.query_row("SELECT 1 FROM actor_turn_draft_commands WHERE owner_scope=? AND simulation_id=? AND command_id=? UNION ALL SELECT 1 FROM accepted_actor_turn_draft_identities WHERE owner_scope=? AND simulation_id=? AND generation_command_id=? LIMIT 1",params![owner,simulation,id,owner,simulation,id],|row| row.get::<_,i64>(0)).optional().map_err(sql_error)?.is_some();
        if collision {
            return Err(EngineError::command_conflict(id));
        }
        let row=self.connection.query_row("SELECT canonical_input_json,fingerprint FROM command_results WHERE owner_scope=? AND simulation_id=? AND command_id=?",params![owner,simulation,id],|row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).optional().map_err(sql_error)?;
        let Some((canonical, digest)) = row else {
            return Ok(None);
        };
        let canonical: Value =
            serde_json::from_str(&canonical).map_err(|e| invalid(e.to_string()))?;
        if fingerprint(&canonical) != digest {
            return Err(invalid(
                "Stored command fingerprint does not match canonical input.",
            ));
        }
        if canonical["kind"] != "accept_draft"
            || canonical["ownerScope"] != *owner
            || canonical["simulationId"] != *simulation
            || canonical["commandId"] != *id
        {
            return Err(EngineError::command_conflict(id));
        }
        let receipt = &canonical["payload"];
        draft_contracts::accept_receipt(receipt)?;
        if receipt["draftId"] != request.draft_id {
            return Err(EngineError::command_conflict(id));
        }
        let expected_source = if request
            .final_text
            .as_ref()
            .is_none_or(|text| receipt["generatedArtifact"]["text"] == *text)
        {
            if receipt["routing"]["preservedText"].is_null() {
                "generated_verbatim"
            } else {
                "director_preserved"
            }
        } else {
            "acceptor_edited"
        };
        if receipt["accepted"]["textSource"] != expected_source
            || request
                .final_text
                .as_deref()
                .is_some_and(|text| crate::acceptance::accepted_text(receipt).ok() != Some(text))
        {
            return Err(EngineError::command_conflict(id));
        }
        let prior = read_commit_replay(&self.connection, &canonical)?
            .ok_or_else(|| invalid("Accepted draft receipt disappeared."))?;
        let duplicate=self.connection.query_row("SELECT 1 FROM command_results WHERE owner_scope=? AND simulation_id=? AND command_id<>? AND json_extract(canonical_input_json,'$.kind')='accept_draft' AND json_extract(canonical_input_json,'$.payload.draftId')=? LIMIT 1",params![owner,simulation,id,request.draft_id],|row| row.get::<_,i64>(0)).optional().map_err(sql_error)?.is_some();
        if duplicate {
            return Err(invalid("Draft has more than one accepted receipt."));
        }
        crate::acceptance::verify_recorded_acceptance(self, &canonical, &prior.commit)?;
        crate::archive::validate(&self.export_simulation(owner, simulation)?)?;
        Ok(Some(prior))
    }
    pub fn commit_accepted_draft(
        &mut self,
        request: &AcceptRequest,
        command: &Value,
        created_at: &str,
    ) -> Result<Committed> {
        // The transaction borrows the connection immutably so pure projections
        // can use this reader while the immediate write lock remains held.
        let transaction =
            rusqlite::Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)
                .map_err(sql_error)?;
        if let Some(prior) = self.replay_accepted_draft(request)? {
            return Ok(prior);
        }
        if !draft_contracts::valid_iso(&json!(created_at)) {
            return Err(invalid("Draft acceptance timestamp is invalid."));
        }
        let draft = read_actor_draft(
            &transaction,
            &request.owner_scope,
            &request.simulation_id,
            &request.draft_id,
        )?
        .ok_or_else(|| EngineError {
            code: ErrorCode::NotFound,
            message: "Draft not found.".into(),
        })?;
        let validated = crate::acceptance::validate_ready_draft(self, request, &draft)?;
        let expected = crate::acceptance::recorded_acceptance(request, &validated)?;
        if fingerprint(&expected) != fingerprint(command) {
            return Err(invalid(
                "Draft acceptance command is not bound to the validated draft.",
            ));
        }
        let branch = string(&draft, "branchId")?;
        let head = string(&draft, "basisHeadCommitId")?;
        let commit = crate::acceptance::build_accepted_commit(
            self,
            &request.owner_scope,
            &request.simulation_id,
            branch,
            head,
            &expected["payload"],
            &request.command_id,
            created_at,
        )?;
        transaction
            .execute(
                "INSERT INTO commits VALUES (?,?,?,?,?,?,?,?)",
                params![
                    commit.id,
                    commit.owner_scope,
                    commit.simulation_id,
                    commit.parent_commit_id,
                    commit.kind,
                    commit.command_id,
                    json_text(&commit.events),
                    commit.created_at
                ],
            )
            .map_err(sql_error)?;
        let changed=transaction.execute("UPDATE branches SET head_commit_id=? WHERE owner_scope=? AND simulation_id=? AND id=? AND head_commit_id=?",params![commit.id,request.owner_scope,request.simulation_id,branch,head]).map_err(sql_error)?;
        if changed != 1 {
            return Err(branch_conflict(head, "missing"));
        }
        let mut accepted = draft.clone();
        accepted["status"] = json!("accepted");
        accepted["updatedAt"] = json!(now());
        let changed=transaction.execute("UPDATE actor_turn_drafts SET status='accepted',draft_json=?,updated_at=? WHERE owner_scope=? AND simulation_id=? AND id=? AND status='ready'",params![json_text(&accepted),string(&accepted,"updatedAt")?,request.owner_scope,request.simulation_id,request.draft_id]).map_err(sql_error)?;
        if changed != 1 {
            return Err(invalid(
                "Draft terminal transition lost its compare-and-set race.",
            ));
        }
        let branch = self
            .branch(&request.owner_scope, &request.simulation_id, branch)?
            .ok_or_else(|| invalid("Accepted branch disappeared."))?;
        let outcome = json!({"kind":"commit","branch":branch,"commit":commit});
        transaction
            .execute(
                "INSERT INTO command_results VALUES (?,?,?,?,?,?,?)",
                params![
                    request.owner_scope,
                    request.simulation_id,
                    request.command_id,
                    json_text(&expected),
                    fingerprint(&expected),
                    json_text(&outcome),
                    now()
                ],
            )
            .map_err(sql_error)?;
        let generation = string(&draft, "generationCommandId")?;
        let reserved=transaction.query_row("SELECT generation_command_id,draft_id FROM accepted_actor_turn_draft_identities WHERE owner_scope=? AND simulation_id=? AND (generation_command_id=? OR draft_id=?)",params![request.owner_scope,request.simulation_id,generation,request.draft_id],|row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).optional().map_err(sql_error)?;
        if let Some((saved_generation, saved_draft)) = reserved {
            if saved_generation != generation || saved_draft != request.draft_id {
                return Err(EngineError::command_conflict(generation));
            }
        } else {
            transaction
                .execute(
                    "INSERT INTO accepted_actor_turn_draft_identities VALUES (?,?,?,?,?)",
                    params![
                        request.owner_scope,
                        request.simulation_id,
                        generation,
                        request.draft_id,
                        created_at
                    ],
                )
                .map_err(sql_error)?;
        }
        transaction.commit().map_err(sql_error)?;
        Ok(Committed {
            branch,
            commit,
            replayed: false,
        })
    }
    pub fn reserve_actor_draft(
        &mut self,
        draft: Value,
        command_fingerprint: &str,
    ) -> Result<(Value, bool)> {
        draft_contracts::draft_record(&draft)?;
        if draft["routing"]["version"].as_f64() == Some(4.0) {
            return Err(invalid(
                "Historical routing requires a saved alternative operation.",
            ));
        }
        let owner = string(&draft, "ownerScope")?;
        let simulation = string(&draft, "simulationId")?;
        let command = string(&draft, "generationCommandId")?;
        let id = string(&draft, "id")?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        if let Some(prior) = read_draft_command(
            &transaction,
            owner,
            simulation,
            command,
            command_fingerprint,
        )? {
            return Ok((prior, true));
        }
        let accepted=transaction.query_row("SELECT 1 FROM accepted_actor_turn_draft_identities WHERE owner_scope=? AND simulation_id=? AND draft_id=?",params![owner,simulation,id],|r| r.get::<_,i64>(0)).optional().map_err(sql_error)?.is_some();
        if accepted {
            return Err(EngineError::command_conflict(command));
        }
        let branch = string(&draft, "branchId")?;
        let head = string(&draft, "basisHeadCommitId")?;
        let branch = read_branch(&transaction, owner, simulation, branch)
            .map_err(sql_error)?
            .ok_or_else(|| EngineError {
                code: ErrorCode::NotFound,
                message: format!("Branch not found: {branch}"),
            })?;
        if branch.head_commit_id != head {
            return Err(branch_conflict(head, &branch.head_commit_id));
        }
        if draft["status"] != "generating" {
            return Err(invalid("New draft must be generating."));
        }
        transaction
            .execute(
                "INSERT INTO actor_turn_drafts VALUES (?,?,?,?,?,?,?,?)",
                params![
                    id,
                    owner,
                    simulation,
                    command,
                    string(&draft, "status")?,
                    json_text(&draft),
                    string(&draft, "createdAt")?,
                    string(&draft, "updatedAt")?
                ],
            )
            .map_err(sql_error)?;
        write_draft_command(
            &transaction,
            owner,
            simulation,
            command,
            "generate",
            id,
            command_fingerprint,
        )?;
        transaction.commit().map_err(sql_error)?;
        Ok((draft, false))
    }
    pub fn transition_actor_draft(
        &mut self,
        owner: &str,
        simulation: &str,
        id: &str,
        artifact: Option<&Value>,
        failure: Option<&Value>,
    ) -> Result<Value> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        let mut draft =
            read_actor_draft(&transaction, owner, simulation, id)?.ok_or_else(|| EngineError {
                code: ErrorCode::NotFound,
                message: format!("Draft not found: {id}"),
            })?;
        if draft["status"] != "generating" {
            return Err(invalid(format!("Draft is not generating: {id}")));
        }
        if artifact.is_some() == failure.is_some() {
            return Err(invalid(
                "Draft completion must contain an artifact or failure.",
            ));
        }
        draft["status"] = json!(if artifact.is_some() {
            "ready"
        } else {
            "failed"
        });
        draft["artifact"] = artifact.cloned().unwrap_or(Value::Null);
        draft["failure"] = failure.cloned().unwrap_or(Value::Null);
        draft["updatedAt"] = json!(now());
        draft_contracts::draft_record(&draft)?;
        let changed=transaction.execute("UPDATE actor_turn_drafts SET status=?,draft_json=?,updated_at=? WHERE owner_scope=? AND simulation_id=? AND id=? AND status='generating'",params![string(&draft,"status")?,json_text(&draft),string(&draft,"updatedAt")?,owner,simulation,id]).map_err(sql_error)?;
        if changed != 1 {
            return Err(invalid(
                "Draft terminal transition lost its compare-and-set race.",
            ));
        }
        transaction.commit().map_err(sql_error)?;
        Ok(draft)
    }
    pub fn discard_actor_draft(
        &mut self,
        owner: &str,
        simulation: &str,
        id: &str,
        command: &str,
    ) -> Result<(Value, bool)> {
        let input = json!({"ownerScope":owner,"simulationId":simulation,"draftId":id,"commandId":command,"kind":"discard_draft"});
        let digest = fingerprint(&input);
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        if let Some(prior) = read_draft_command(&transaction, owner, simulation, command, &digest)?
        {
            return Ok((prior, true));
        }
        let mut draft =
            read_actor_draft(&transaction, owner, simulation, id)?.ok_or_else(|| EngineError {
                code: ErrorCode::NotFound,
                message: format!("Draft not found: {id}"),
            })?;
        if draft["generationCommandId"] == command {
            return Err(invalid("Discard requires a distinct command ID."));
        }
        if !["generating", "ready", "failed"].contains(&string(&draft, "status")?) {
            return Err(invalid(format!(
                "Draft cannot be discarded from {}.",
                string(&draft, "status")?
            )));
        }
        draft["status"] = json!("discarded");
        draft["updatedAt"] = json!(now());
        draft_contracts::draft_record(&draft)?;
        let changed=transaction.execute("UPDATE actor_turn_drafts SET status='discarded',draft_json=?,updated_at=? WHERE owner_scope=? AND simulation_id=? AND id=? AND status IN ('generating','ready','failed')",params![json_text(&draft),string(&draft,"updatedAt")?,owner,simulation,id]).map_err(sql_error)?;
        if changed != 1 {
            return Err(invalid(
                "Draft terminal transition lost its compare-and-set race.",
            ));
        }
        write_draft_command(
            &transaction,
            owner,
            simulation,
            command,
            "discard",
            id,
            &digest,
        )?;
        transaction.commit().map_err(sql_error)?;
        Ok((draft, false))
    }
}
pub(super) fn read_actor_draft(
    connection: &Connection,
    owner: &str,
    simulation: &str,
    id: &str,
) -> Result<Option<Value>> {
    let draft=connection.query_row("SELECT draft_json FROM actor_turn_drafts WHERE owner_scope=? AND simulation_id=? AND id=?",params![owner,simulation,id],|r| parse::<Value>(r.get(0)?)).optional().map_err(sql_error)?;
    if let Some(draft) = &draft {
        draft_contracts::draft_record(draft)?;
        if draft["id"] != id || draft["ownerScope"] != owner || draft["simulationId"] != simulation
        {
            return Err(invalid(
                "Draft identity does not match persisted owner scope.",
            ));
        }
    }
    Ok(draft)
}
fn read_draft_command(
    connection: &Connection,
    owner: &str,
    simulation: &str,
    id: &str,
    digest: &str,
) -> Result<Option<Value>> {
    assert_no_historical_command(connection, owner, simulation, id)?;
    let canonical=connection.query_row("SELECT 1 FROM command_results WHERE owner_scope=? AND simulation_id=? AND command_id=?",params![owner,simulation,id],|r| r.get::<_,i64>(0)).optional().map_err(sql_error)?.is_some();
    if canonical {
        return Err(EngineError::command_conflict(id));
    }
    let row=connection.query_row("SELECT fingerprint,draft_id FROM actor_turn_draft_commands WHERE owner_scope=? AND simulation_id=? AND command_id=?",params![owner,simulation,id],|r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional().map_err(sql_error)?;
    if let Some((stored, draft)) = row {
        if stored != digest {
            return Err(EngineError::command_conflict(id));
        }
        return read_actor_draft(connection, owner, simulation, &draft)?
            .map(Some)
            .ok_or_else(|| EngineError::command_conflict(id));
    }
    let accepted=connection.query_row("SELECT 1 FROM accepted_actor_turn_draft_identities WHERE owner_scope=? AND simulation_id=? AND generation_command_id=?",params![owner,simulation,id],|r| r.get::<_,i64>(0)).optional().map_err(sql_error)?.is_some();
    if accepted {
        return Err(EngineError::command_conflict(id));
    }
    Ok(None)
}
fn write_draft_command(
    connection: &Connection,
    owner: &str,
    simulation: &str,
    command: &str,
    kind: &str,
    id: &str,
    digest: &str,
) -> Result<()> {
    connection
        .execute(
            "INSERT INTO actor_turn_draft_commands VALUES (?,?,?,?,?,?,?)",
            params![owner, simulation, command, kind, id, digest, now()],
        )
        .map_err(sql_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        application::{StartRequest, start_from_source},
        context::{ContextOptions, inspect_actor_context},
        identity::sha256,
        runtime::{Observation, artifact_digest, canonical_context, provenance},
    };
    #[test]
    fn accepted_wording_and_whispers_are_atomic_and_replay_without_operational_draft_rows() {
        use crate::{
            acceptance::accept_actor_draft,
            commands::stage_whisper,
            drafts::{PrepareOptions, finish_runtime, prepare_actor_draft},
            runtime::RuntimeStream,
        };
        let mut store = Store::open(Path::new(":memory:")).unwrap();
        let started = start_from_source(
            &mut store,
            StartRequest {
                owner_scope: "local",
                simulation_id: "story",
                command_id: "start",
                scenario_id: None,
                branch_id: Some("main".into()),
            },
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/last-crossing"),
        )
        .unwrap();
        let whisper=stage_whisper(&mut store,json!({"ownerScope":"local","simulationId":"story","branchId":"main","expectedHead":started.root.id,"commandId":"whisper","targetActorId":"corin","text":"Private direction."})).unwrap();
        let command = Command {
            owner_scope: "local".into(),
            simulation_id: "story".into(),
            branch_id: "main".into(),
            expected_head: started.root.id.clone(),
            command_id: "generate".into(),
            payload: json!({"actorId":"corin","audience":["mara"],"stageWhisperIds":[whisper["id"]],"runtimeProfile":{"id":"local-character","version":"v1"},"promptPolicy":{"id":"default","version":"v1"},"outputSchema":{"id":"screenplay","digest":"schema-v1"},"skillDigests":[]}),
        };
        let prepared = prepare_actor_draft(&mut store, command, PrepareOptions::default()).unwrap();
        let mut stream = RuntimeStream::default();
        stream.push(&json!({"type":"completed","text":"  Candidate.  ","usage":{"inputTokens":2,"outputTokens":3}})).unwrap();
        let ready = finish_runtime(
            &mut store,
            &prepared.draft,
            &json!({"id":"test","version":"v1"}),
            stream.finish(),
        )
        .unwrap();
        let request = AcceptRequest {
            owner_scope: "local".into(),
            simulation_id: "story".into(),
            draft_id: string(&ready, "id").unwrap().into(),
            command_id: "accept".into(),
            final_text: Some("\n Edited wording. \n".into()),
        };
        let accepted = accept_actor_draft(&mut store, request.clone()).unwrap();
        assert!(!accepted.replayed);
        assert_eq!(
            accepted.commit.events[0]["message"]["text"],
            "\n Edited wording. \n"
        );
        assert_eq!(
            accepted.commit.events[0]["message"]["provenance"]["finalTextSource"],
            "acceptor_edited"
        );
        assert!(
            accepted
                .commit
                .events
                .iter()
                .any(|event| event["type"] == "stage_whisper_consumed"
                    && event["whisperId"] == whisper["id"])
        );
        assert_eq!(
            store
                .actor_draft("local", "story", &request.draft_id)
                .unwrap()
                .unwrap()["status"],
            "accepted"
        );
        assert!(
            accept_actor_draft(&mut store, request.clone())
                .unwrap()
                .replayed
        );
        let mut changed = request.clone();
        changed.final_text = Some("Different.".into());
        assert_eq!(
            accept_actor_draft(&mut store, changed).unwrap_err().code,
            ErrorCode::CommandConflict
        );
        store
            .connection
            .execute("DELETE FROM actor_turn_draft_commands", [])
            .unwrap();
        store
            .connection
            .execute("DELETE FROM actor_turn_drafts", [])
            .unwrap();
        assert!(
            accept_actor_draft(&mut store, request.clone())
                .unwrap()
                .replayed
        );
        let committed = store
            .commit("local", "story", &accepted.commit.id)
            .unwrap()
            .unwrap();
        assert_eq!(committed, accepted.commit);
        let forged = json!({"kind":"commit","branch":accepted.branch,"commit":{}});
        store
            .connection
            .execute(
                "UPDATE command_results SET result_json=? WHERE command_id='accept'",
                [json_text(&forged)],
            )
            .unwrap();
        assert!(accept_actor_draft(&mut store, request).is_err());
        assert_eq!(
            store
                .ancestry("local", "story", &accepted.commit.id)
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn durable_candidate_reservations_share_command_identity_and_discard_blocks_late_completion() {
        let mut store = Store::open(Path::new(":memory:")).unwrap();
        let started = start_from_source(
            &mut store,
            StartRequest {
                owner_scope: "local",
                simulation_id: "story",
                command_id: "start",
                scenario_id: None,
                branch_id: Some("main".into()),
            },
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/last-crossing"),
        )
        .unwrap();
        let context = inspect_actor_context(
            &store,
            "local",
            "story",
            "main",
            None,
            "corin",
            ContextOptions::default(),
        )
        .unwrap();
        let prompt = context["promptPreview"].as_str().unwrap();
        let canonical = canonical_context(&context);
        let created = now();
        let id = domain_id("actor_turn_draft", &["local", "story", "generate"]);
        let draft = json!({"id":id,"ownerScope":"local","simulationId":"story","generationCommandId":"generate","branchId":"main","basisHeadCommitId":started.root.id,"contentRevisionId":started.content_revision.id,"actorId":"corin","audience":["corin"],"stageWhispers":[],"runtimeProfile":{"id":"local-character","version":"v1"},"promptPolicy":{"id":"default","version":"v1"},"outputSchema":{"id":"screenplay","digest":"schema-v1"},"skillDigests":[],"capabilityGrant":[],"context":canonical,"contextHash":fingerprint(&canonical),"prompt":prompt,"promptHash":sha256(prompt),"status":"generating","artifact":null,"failure":null,"createdAt":created,"updatedAt":created});
        let digest = fingerprint(&json!({"command":"captured generation"}));
        assert!(!store.reserve_actor_draft(draft.clone(), &digest).unwrap().1);
        assert!(store.reserve_actor_draft(draft.clone(), &digest).unwrap().1);
        assert_eq!(
            store
                .reserve_actor_draft(draft.clone(), &fingerprint(&json!({"command":"changed"})))
                .unwrap_err()
                .code,
            ErrorCode::CommandConflict
        );
        let artifact = json!({"text":"A candidate.","digest":artifact_digest("A candidate.",None),"provenance":provenance(&json!({"id":"dsh","version":"v1"}),&draft["runtimeProfile"],&Observation::default(),true)});
        let ready = store
            .transition_actor_draft("local", "story", &id, Some(&artifact), None)
            .unwrap();
        assert_eq!(ready["status"], "ready");
        let (discarded, replayed) = store
            .discard_actor_draft("local", "story", &id, "discard")
            .unwrap();
        assert!(!replayed);
        assert_eq!(discarded["status"], "discarded");
        assert!(
            store
                .discard_actor_draft("local", "story", &id, "discard")
                .unwrap()
                .1
        );
        assert!(
            store
                .transition_actor_draft("local", "story", &id, Some(&artifact), None)
                .is_err()
        );
        assert_eq!(
            store.actor_draft("local", "story", &id).unwrap(),
            Some(discarded)
        );
        assert!(
            store
                .recoverable_actor_drafts("local", "story", "main")
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            store
                .branch("local", "story", "main")
                .unwrap()
                .unwrap()
                .head_commit_id,
            started.root.id
        );
        assert!(store.actor_draft("other", "story", &id).unwrap().is_none());
    }
}
