use super::*;
use crate::{alternatives, identity::locale_compare, projection::string};
impl crate::ports::AlternativeReader for Store {
    fn export_archive(&self, o: &str, s: &str) -> Result<crate::archive::SimulationArchive> {
        self.export_simulation(o, s)
    }
    fn alternative(&self, o: &str, s: &str, id: &str) -> Result<Option<Value>> {
        Store::alternative(self, o, s, id)
    }
}
impl crate::ports::SavedAlternativeRepository for Store {
    fn reserve_alternative(&mut self, record: Value) -> Result<(Value, bool)> {
        Store::reserve_alternative(self, record)
    }
    fn update_alternative_draft(&mut self, record: &Value, draft: Value) -> Result<Value> {
        Store::update_alternative_draft(self, record, draft)
    }
    fn settle_alternative(
        &mut self,
        o: &str,
        s: &str,
        id: &str,
        status: &str,
        failure: Option<&str>,
    ) -> Result<Value> {
        Store::settle_alternative(self, o, s, id, status, failure)
    }
    fn save_alternative(&mut self, o: &str, s: &str, id: &str) -> Result<Value> {
        Store::save_alternative(self, o, s, id)
    }
}
impl Store {
    pub fn reserve_alternative(&mut self, record: Value) -> Result<(Value, bool)> {
        let transaction =
            rusqlite::Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)
                .map_err(sql_error)?;
        let request = &record["request"];
        crate::archive::recorded::alternative_request(request)?;
        let id = alternatives::id(request)?;
        let hash = fingerprint(request);
        let owner = string(request, "ownerScope")?;
        let sim = string(request, "simulationId")?;
        if record["id"] != id || record["fingerprint"] != hash {
            return Err(invalid("Historical reservation identity mismatch."));
        }
        if let Some(previous) = self.alternative(owner, sim, &id)? {
            if previous["fingerprint"] != hash {
                return Err(EngineError::command_conflict(string(request, "commandId")?));
            }
            return Ok((previous, true));
        }
        let mut identities = vec![string(request, "commandId")?.to_owned()];
        if request["action"] == "generate" {
            identities.push(domain_id("alternative_generation", &[&id]));
        }
        for command in &identities {
            assert_no_historical_command(&self.connection, owner, sim, command)?;
            let collision=self.connection.query_row("SELECT 1 FROM command_results WHERE owner_scope=? AND simulation_id=? AND command_id=? UNION ALL SELECT 1 FROM actor_turn_draft_commands WHERE owner_scope=? AND simulation_id=? AND command_id=? UNION ALL SELECT 1 FROM accepted_actor_turn_draft_identities WHERE owner_scope=? AND simulation_id=? AND generation_command_id=? LIMIT 1",params![owner,sim,command,owner,sim,command,owner,sim,command],|r|r.get::<_,i64>(0)).optional().map_err(sql_error)?.is_some();
            if collision {
                return Err(EngineError::command_conflict(command));
            }
        }
        let selected = alternatives::select_live(self, request, true)?;
        let simulation = self
            .simulation(owner, sim)?
            .ok_or_else(|| invalid("Historical simulation is missing."))?;
        if record["parentCommitId"] != selected.parent
            || record["contentRevisionId"] != simulation.content_revision_id
            || record["status"] != "pending"
            || !record["draft"].is_null()
            || !record["failure"].is_null()
            || !record["outcome"].is_null()
        {
            return Err(invalid("Historical reservation basis or state is invalid."));
        }
        write_alternative(&transaction, &record)?;
        transaction.commit().map_err(sql_error)?;
        Ok((record, false))
    }
    pub fn update_alternative_draft(&mut self, record: &Value, draft: Value) -> Result<Value> {
        let r = &record["request"];
        let owner = string(r, "ownerScope")?;
        let sim = string(r, "simulationId")?;
        let transaction =
            rusqlite::Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)
                .map_err(sql_error)?;
        let mut current = self
            .alternative(owner, sim, string(record, "id")?)?
            .ok_or_else(|| invalid("Historical operation is missing."))?;
        if current["status"] != "pending"
            || !current["draft"].is_null() && current["draft"]["status"] != "generating"
        {
            return Ok(current);
        }
        if current["draft"].is_null() {
            alternatives::select_live(self, &current["request"], true)?;
            if let Some(retry) = current["request"].get("retryOf")
                && let Some(source) = self.alternative(owner, sim, retry.as_str().unwrap())?
                && !source["draft"].is_null()
                && (source["draft"]["promptHash"] != draft["promptHash"]
                    || source["draft"]["contextHash"] != draft["contextHash"])
            {
                return Err(invalid(
                    "Historical retry context differs from frozen input.",
                ));
            }
        }
        crate::draft_contracts::draft_record(&draft)?;
        if current["request"]["action"] != "generate"
            || draft["ownerScope"] != owner
            || draft["simulationId"] != sim
            || draft["generationCommandId"]
                != domain_id("alternative_generation", &[string(&current, "id")?])
            || draft["branchId"] != current["request"]["sourceBranchId"]
            || draft["basisHeadCommitId"] != current["parentCommitId"]
            || draft["contentRevisionId"] != current["contentRevisionId"]
        {
            return Err(invalid("Historical candidate identity or basis mismatch."));
        }
        if !current["draft"].is_null() {
            for key in [
                "id",
                "ownerScope",
                "simulationId",
                "generationCommandId",
                "branchId",
                "basisHeadCommitId",
                "contentRevisionId",
                "actorId",
                "audience",
                "stageWhispers",
                "runtimeProfile",
                "promptPolicy",
                "outputSchema",
                "skillDigests",
                "capabilityGrant",
                "context",
                "contextHash",
                "prompt",
                "promptHash",
                "routing",
                "createdAt",
            ] {
                if fingerprint(&current["draft"][key]) != fingerprint(&draft[key]) {
                    return Err(invalid("Historical completion changed its frozen input."));
                }
            }
        }
        current["draft"] = draft;
        current["updatedAt"] = json!(now());
        write_alternative(&transaction, &current)?;
        transaction.commit().map_err(sql_error)?;
        Ok(current)
    }
    pub fn save_alternative(&mut self, owner: &str, simulation: &str, id: &str) -> Result<Value> {
        let transaction =
            rusqlite::Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)
                .map_err(sql_error)?;
        let mut current = self
            .alternative(owner, simulation, id)?
            .ok_or_else(|| invalid("Historical operation is missing."))?;
        if current["status"] != "pending" {
            return Ok(current);
        }
        let (command, commit, branch) = alternatives::build_alternative_commit(self, &current)?;
        transaction
            .execute(
                "INSERT INTO commits VALUES (?,?,?,?,?,?,?,?)",
                params![
                    commit.id,
                    owner,
                    simulation,
                    commit.parent_commit_id,
                    commit.kind,
                    commit.command_id,
                    json_text(&commit.events),
                    commit.created_at
                ],
            )
            .map_err(sql_error)?;
        transaction
            .execute(
                "INSERT INTO branches VALUES (?,?,?,?,?,?,?)",
                params![
                    branch.id,
                    owner,
                    simulation,
                    branch.name,
                    branch.head_commit_id,
                    json_text(&branch.origin),
                    branch.created_at
                ],
            )
            .map_err(sql_error)?;
        transaction
            .execute(
                "INSERT INTO command_results VALUES (?,?,?,?,?,?,?)",
                params![
                    owner,
                    simulation,
                    commit.command_id,
                    json_text(&command),
                    fingerprint(&command),
                    json_text(&json!({"kind":"commit","branch":branch,"commit":commit})),
                    now()
                ],
            )
            .map_err(sql_error)?;
        current["status"] = json!("saved");
        current["failure"] = Value::Null;
        current["updatedAt"] = json!(now());
        if !current["draft"].is_null() {
            current["draft"]["status"] = json!("accepted");
            current["draft"]["updatedAt"] = json!(now());
        }
        current["outcome"] = json!({"branchId":branch.id,"commitId":commit.id});
        write_alternative(&transaction, &current)?;
        transaction.commit().map_err(sql_error)?;
        Ok(current)
    }
    pub fn alternative(&self, owner: &str, simulation: &str, id: &str) -> Result<Option<Value>> {
        if self.simulation(owner, simulation)?.is_none() {
            return Err(EngineError {
                code: ErrorCode::NotFound,
                message: "Simulation not found.".into(),
            });
        }
        let row=self.connection.query_row("SELECT record_json FROM saved_alternative_operations WHERE owner_scope=? AND simulation_id=? AND id=?",params![owner,simulation,id],|r|parse::<Value>(r.get(0)?)).optional().map_err(sql_error)?;
        if row.is_some() {
            return Ok(row);
        }
        let archive = self.export_simulation(owner, simulation)?;
        for command in archive.command_results.iter().filter(|c| {
            c.canonical_input["kind"] == "saved_alternative" && c.result["kind"] == "commit"
        }) {
            let op = alternatives::from_receipt(
                &command.canonical_input,
                &command.result["branch"],
                &command.result["commit"],
            )?;
            if op["id"] == id {
                return Ok(Some(op));
            }
        }
        Ok(None)
    }
    pub fn alternatives(&self, owner: &str, simulation: &str) -> Result<Vec<Value>> {
        let archive = self.export_simulation(owner, simulation)?;
        let mut all = std::collections::BTreeMap::new();
        for command in archive.command_results.iter().filter(|c| {
            c.canonical_input["kind"] == "saved_alternative" && c.result["kind"] == "commit"
        }) {
            let op = alternatives::from_receipt(
                &command.canonical_input,
                &command.result["branch"],
                &command.result["commit"],
            )?;
            all.insert(string(&op, "id")?.to_owned(), op);
        }
        let rows=self.connection.prepare("SELECT record_json FROM saved_alternative_operations WHERE owner_scope=? AND simulation_id=?").map_err(sql_error)?.query_map(params![owner,simulation],|r|parse::<Value>(r.get(0)?)).map_err(sql_error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_error)?;
        for op in rows {
            all.insert(string(&op, "id")?.to_owned(), op);
        }
        let mut result = all.into_values().collect::<Vec<_>>();
        for op in &result {
            string(op, "createdAt")?;
        }
        result.sort_by(|a, b| {
            locale_compare(
                a["createdAt"].as_str().unwrap(),
                b["createdAt"].as_str().unwrap(),
            )
            .then_with(|| locale_compare(a["id"].as_str().unwrap(), b["id"].as_str().unwrap()))
        });
        Ok(result)
    }
    pub fn settle_alternative(
        &mut self,
        owner: &str,
        simulation: &str,
        id: &str,
        status: &str,
        failure: Option<&str>,
    ) -> Result<Value> {
        if !["failed", "discarded"].contains(&status) {
            return Err(invalid("Invalid historical terminal status."));
        }
        let transaction =
            rusqlite::Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)
                .map_err(sql_error)?;
        let mut current = self
            .alternative(owner, simulation, id)?
            .ok_or_else(|| EngineError {
                code: ErrorCode::NotFound,
                message: "Historical operation not found.".into(),
            })?;
        if current["status"] != "pending"
            && !(status == "discarded" && current["status"] == "failed")
        {
            return Ok(current);
        }
        current["status"] = json!(status);
        current["failure"] = json!(failure);
        current["updatedAt"] = json!(now());
        if status == "discarded" && !current["draft"].is_null() {
            current["draft"]["status"] = json!("discarded");
        }
        transaction.execute("INSERT INTO saved_alternative_operations VALUES (?,?,?,?) ON CONFLICT(owner_scope,simulation_id,id) DO UPDATE SET record_json=excluded.record_json",params![owner,simulation,id,json_text(&current)]).map_err(sql_error)?;
        transaction.commit().map_err(sql_error)?;
        Ok(current)
    }
}
fn write_alternative(connection: &Connection, record: &Value) -> Result<()> {
    let r = &record["request"];
    connection.execute("INSERT INTO saved_alternative_operations VALUES (?,?,?,?) ON CONFLICT(owner_scope,simulation_id,id) DO UPDATE SET record_json=excluded.record_json",params![string(r,"ownerScope")?,string(r,"simulationId")?,string(record,"id")?,json_text(record)]).map_err(sql_error)?;
    Ok(())
}
