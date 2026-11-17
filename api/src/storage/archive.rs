use super::*;
use crate::archive::{RecordedCommandResult, SimulationArchive, recorded};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn acceptance_replay_checks_corruption_on_other_branches_without_host_callbacks() {
        let mut store = Store::open(Path::new(":memory:")).unwrap();
        let fixtures: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/archives.json")).unwrap();
        let mut archive = crate::archive::verify::decode_archive(&fixtures["complete"]).unwrap();
        store.import_simulation(archive.clone()).unwrap();
        let accepted = archive
            .command_results
            .iter()
            .find(|c| c.canonical_input["kind"] == "accept_draft")
            .unwrap();
        let request = AcceptRequest {
            owner_scope: "owner".into(),
            simulation_id: "archive".into(),
            draft_id: accepted.canonical_input["payload"]["draftId"]
                .as_str()
                .unwrap()
                .into(),
            command_id: accepted.command_id.clone(),
            final_text: Some(
                accepted.canonical_input["payload"]["accepted"]["text"]
                    .as_str()
                    .unwrap()
                    .into(),
            ),
        };
        assert!(store.replay_accepted_draft(&request).unwrap().is_some());
        let commit = archive
            .commits
            .iter_mut()
            .find(|c| c.command_id == "edit")
            .unwrap();
        commit.events[0]["message"]["text"] = json!("Forged sibling wording.");
        store
            .connection
            .execute(
                "UPDATE commits SET events_json=? WHERE id=?",
                params![json_text(&commit.events), commit.id],
            )
            .unwrap();
        let receipt = archive
            .command_results
            .iter_mut()
            .find(|c| c.command_id == "edit")
            .unwrap();
        receipt.result["commit"] = serde_json::to_value(commit).unwrap();
        store
            .connection
            .execute(
                "UPDATE command_results SET result_json=? WHERE command_id='edit'",
                [json_text(&receipt.result)],
            )
            .unwrap();
        assert!(store.replay_accepted_draft(&request).is_err());
    }
    #[test]
    fn a_failed_import_rolls_back_revision_history_receipts_and_jobs_together() {
        let mut store = Store::open(Path::new(":memory:")).unwrap();
        let fixtures: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/archives.json")).unwrap();
        let archive = crate::archive::verify::decode_archive(&fixtures["complete"]).unwrap();
        store.connection.execute_batch("CREATE TRIGGER stop_import BEFORE INSERT ON branches BEGIN SELECT RAISE(ABORT,'injected import failure'); END").unwrap();
        assert!(store.import_simulation(archive.clone()).is_err());
        for table in [
            "content_revisions",
            "branch_simulations",
            "commits",
            "branches",
            "command_results",
            "draft_stage_whispers",
            "memory_jobs",
            "memory_job_transitions",
            "detached_memory_operations",
        ] {
            let count: i64 = store
                .connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 0, "{table}");
        }
        store
            .connection
            .execute_batch("DROP TRIGGER stop_import")
            .unwrap();
        store.import_simulation(archive).unwrap();
        assert!(store.export_simulation("owner", "archive").is_ok());
    }
}

impl Store {
    /// One coherent workspace history snapshot, independent of local navigation.
    pub fn export_all(&self, owner: &str) -> Result<Vec<SimulationArchive>> {
        let _snapshot = self.connection.unchecked_transaction().map_err(sql_error)?;
        let ids = self
            .connection
            .prepare("SELECT id FROM branch_simulations WHERE owner_scope=? ORDER BY id")
            .map_err(sql_error)?
            .query_map([owner], |r| r.get::<_, String>(0))
            .map_err(sql_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_error)?;
        ids.iter()
            .map(|id| self.export_simulation(owner, id))
            .collect()
    }
    pub fn import_simulation(&mut self, archive: SimulationArchive) -> Result<()> {
        use crate::{archive, projection::string};
        let archive = archive::normalize(archive)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        let revision = &archive.content_revision;
        let simulation = &archive.simulation;
        transaction
            .execute(
                "INSERT OR IGNORE INTO content_revisions VALUES (?,?,?,?,?)",
                params![
                    revision.id,
                    revision.owner_scope,
                    revision.digest,
                    json_text(&revision.compiled),
                    revision.created_at
                ],
            )
            .map_err(sql_error)?;
        let existing: (String,String,String,String) = transaction.query_row("SELECT owner_scope,digest,compiled_json,created_at FROM content_revisions WHERE id=?",[&revision.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(sql_error)?;
        if existing.0 != revision.owner_scope
            || existing.1 != revision.digest
            || parse::<Value>(existing.2).map_err(sql_error)?
                != serde_json::to_value(&revision.compiled).unwrap()
            || existing.3 != revision.created_at
        {
            return Err(invalid(
                "Imported content revision conflicts with existing content.",
            ));
        }
        transaction
            .execute(
                "INSERT INTO branch_simulations VALUES (?,?,?,?,?,?,?)",
                params![
                    simulation.owner_scope,
                    simulation.id,
                    simulation.content_revision_id,
                    simulation.source_root,
                    simulation.scenario_id,
                    simulation.default_branch_id,
                    simulation.created_at
                ],
            )
            .map_err(sql_error)?;
        let mut inserted = std::collections::HashSet::new();
        while inserted.len() < archive.commits.len() {
            let ready: Vec<_> = archive
                .commits
                .iter()
                .filter(|c| {
                    !inserted.contains(&c.id)
                        && c.parent_commit_id
                            .as_ref()
                            .is_none_or(|p| inserted.contains(p))
                })
                .collect();
            if ready.is_empty() {
                return Err(invalid("Archive commit ancestry is cyclic."));
            }
            for c in ready {
                transaction
                    .execute(
                        "INSERT INTO commits VALUES (?,?,?,?,?,?,?,?)",
                        params![
                            c.id,
                            c.owner_scope,
                            c.simulation_id,
                            c.parent_commit_id,
                            c.kind,
                            c.command_id,
                            json_text(&c.events),
                            c.created_at
                        ],
                    )
                    .map_err(sql_error)?;
                inserted.insert(c.id.clone());
            }
        }
        for b in &archive.branches {
            transaction
                .execute(
                    "INSERT INTO branches VALUES (?,?,?,?,?,?,?)",
                    params![
                        b.id,
                        b.owner_scope,
                        b.simulation_id,
                        b.name,
                        b.head_commit_id,
                        json_text(&b.origin),
                        b.created_at
                    ],
                )
                .map_err(sql_error)?;
        }
        for w in &archive.stage_whispers {
            transaction
                .execute(
                    "INSERT INTO draft_stage_whispers VALUES (?,?,?,?,?,?,?,?,?)",
                    params![
                        string(w, "id")?,
                        string(w, "ownerScope")?,
                        string(w, "simulationId")?,
                        string(w, "branchId")?,
                        string(w, "expectedHead")?,
                        string(w, "commandId")?,
                        string(w, "targetActorId")?,
                        string(w, "text")?,
                        string(w, "createdAt")?
                    ],
                )
                .map_err(sql_error)?;
        }
        for c in &archive.command_results {
            transaction
                .execute(
                    "INSERT INTO command_results VALUES (?,?,?,?,?,?,?)",
                    params![
                        simulation.owner_scope,
                        simulation.id,
                        c.command_id,
                        json_text(&c.canonical_input),
                        c.fingerprint,
                        json_text(&c.result),
                        c.created_at
                    ],
                )
                .map_err(sql_error)?;
            if c.canonical_input["kind"] == "accept_draft" {
                let receipt = &c.canonical_input["payload"];
                transaction
                    .execute(
                        "INSERT INTO accepted_actor_turn_draft_identities VALUES (?,?,?,?,?)",
                        params![
                            simulation.owner_scope,
                            simulation.id,
                            string(receipt, "generationCommandId")?,
                            string(receipt, "draftId")?,
                            c.created_at
                        ],
                    )
                    .map_err(sql_error)?;
            }
        }
        for j in archive.memory_jobs.as_deref().unwrap_or_default() {
            transaction.execute("INSERT INTO memory_jobs (id,owner_scope,simulation_id,origin_branch_id,episode_id,closure_commit_id,basis_head_commit_id,command_id,label,status,attempt_count,result_fingerprint,result_json,last_error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",params![string(j,"id")?,string(j,"ownerScope")?,string(j,"simulationId")?,string(j,"originBranchId")?,string(j,"episodeId")?,string(j,"closureCommitId")?,string(j,"basisHeadCommitId")?,string(j,"commandId")?,j["label"].as_str(),string(j,"status")?,j["attemptCount"].as_i64(),j["resultFingerprint"].as_str(),(!j["result"].is_null()).then(||json_text(&j["result"])),j["lastError"].as_str(),string(j,"createdAt")?,string(j,"updatedAt")?]).map_err(sql_error)?;
        }
        for t in archive
            .memory_job_transitions
            .as_deref()
            .unwrap_or_default()
        {
            transaction
                .execute(
                    "INSERT INTO memory_job_transitions VALUES (?,?,?,?,?,?,?,?,?,?)",
                    params![
                        string(t, "id")?,
                        string(t, "jobId")?,
                        string(t, "ownerScope")?,
                        string(t, "simulationId")?,
                        t["attempt"].as_i64(),
                        string(t, "status")?,
                        t["resultFingerprint"].as_str(),
                        (!t["result"].is_null()).then(|| json_text(&t["result"])),
                        t["error"].as_str(),
                        string(t, "createdAt")?
                    ],
                )
                .map_err(sql_error)?;
        }
        for op in archive
            .detached_memory_operations
            .as_deref()
            .unwrap_or_default()
        {
            let job = archive
                .memory_jobs
                .as_ref()
                .and_then(|jobs| {
                    jobs.iter()
                        .find(|j| j["closureCommitId"] == op["closureCommitId"])
                })
                .ok_or_else(|| invalid("Detached memory operation has no job."))?;
            transaction
                .execute(
                    "INSERT INTO detached_memory_operations VALUES (?,?,?,?,?)",
                    params![
                        string(op, "id")?,
                        simulation.owner_scope,
                        simulation.id,
                        string(job, "id")?,
                        json_text(op)
                    ],
                )
                .map_err(sql_error)?;
        }
        transaction.commit().map_err(sql_error)
    }

    /// Read one SQLite snapshot so an accepted commit cannot be exported without
    /// its command receipt, branch update or job transition from the same write.
    pub fn export_simulation(&self, owner: &str, id: &str) -> Result<SimulationArchive> {
        // Replay may already hold an immediate write transaction. That lock
        // supplies the snapshot; SQLite does not permit a nested BEGIN.
        let snapshot = if self.connection.is_autocommit() {
            Some(
                rusqlite::Transaction::new_unchecked(
                    &self.connection,
                    TransactionBehavior::Deferred,
                )
                .map_err(sql_error)?,
            )
        } else {
            None
        };
        let simulation = self.simulation(owner, id)?.ok_or_else(|| EngineError {
            code: ErrorCode::NotFound,
            message: format!("Simulation not found: {id}"),
        })?;
        let content_revision = self
            .revision(owner, &simulation.content_revision_id)?
            .ok_or_else(|| invalid("Simulation content revision is missing."))?;
        let branches = self.branches(owner, id)?;
        let ids = self.connection.prepare("SELECT id FROM commits WHERE owner_scope=? AND simulation_id=? ORDER BY created_at,id").map_err(sql_error)?
            .query_map(params![owner,id], |r| r.get::<_,String>(0)).map_err(sql_error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_error)?;
        let commits = ids
            .into_iter()
            .map(|commit| {
                self.commit(owner, id, &commit)?
                    .ok_or_else(|| invalid("Archive commit is missing."))
            })
            .collect::<Result<Vec<_>>>()?;
        let command_results = self.connection.prepare("SELECT command_id,canonical_input_json,fingerprint,result_json,created_at FROM command_results WHERE owner_scope=? AND simulation_id=? ORDER BY created_at,command_id").map_err(sql_error)?
            .query_map(params![owner,id], |r| Ok(RecordedCommandResult { command_id:r.get(0)?,canonical_input:parse(r.get(1)?)?,fingerprint:r.get(2)?,result:parse(r.get(3)?)?,created_at:r.get(4)? })).map_err(sql_error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_error)?;
        for command in &command_results {
            recorded::command_result(command)?;
        }
        let stage_whispers = self.connection.prepare("SELECT id,branch_id,expected_head,command_id,target_actor_id,text,created_at FROM draft_stage_whispers WHERE owner_scope=? AND simulation_id=? ORDER BY created_at,id").map_err(sql_error)?
            .query_map(params![owner,id], |r| Ok(json!({"id":r.get::<_,String>(0)?,"ownerScope":owner,"simulationId":id,"branchId":r.get::<_,String>(1)?,"expectedHead":r.get::<_,String>(2)?,"commandId":r.get::<_,String>(3)?,"targetActorId":r.get::<_,String>(4)?,"text":r.get::<_,String>(5)?,"createdAt":r.get::<_,String>(6)?}))).map_err(sql_error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_error)?;
        let result = SimulationArchive {
            schema_version: if command_results.iter().any(|c| {
                matches!(
                    c.canonical_input["kind"].as_str(),
                    Some("saved_alternative" | "correct_turn_body")
                )
            }) {
                7
            } else {
                6
            },
            content_revision,
            simulation,
            branches,
            commits,
            stage_whispers,
            command_results,
            memory_jobs: Some(self.memory_jobs(owner, id)?),
            memory_job_transitions: Some(self.memory_job_transitions(owner, id, None)?),
            detached_memory_operations: Some(self.detached_memory_operations(owner, id)?),
        };
        if let Some(snapshot) = snapshot {
            snapshot.commit().map_err(sql_error)?;
        }
        Ok(result)
    }
}
