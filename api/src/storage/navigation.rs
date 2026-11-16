use super::*;
fn token(value: &str) -> Result<()> {
    let whitespace = |c: char| matches!(c,'\t'..='\r'|'\u{20}'|'\u{a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}');
    if value.is_empty()
        || value.encode_utf16().count() > 200
        || value
            .chars()
            .any(|c| whitespace(c) || c <= '\u{1f}' || c == '\u{7f}' || c == '/' || c == '\\')
        || [".", ".."].contains(&value)
    {
        return Err(invalid("Invalid navigation token."));
    }
    Ok(())
}
impl Store {
    pub fn navigation_version(&self, owner: &str) -> Result<Option<String>> {
        if owner.is_empty() {
            return Err(invalid("Saved identity must be a non-empty string."));
        }
        self.connection
            .query_row(
                "SELECT version FROM application_navigation_version WHERE owner_scope=?",
                [owner],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql_error)
    }
    pub fn record_simulation_opened(
        &mut self,
        owner: &str,
        simulation: &str,
        branch: &str,
        operation: &str,
        expected: Option<&str>,
    ) -> Result<Value> {
        if [owner, simulation, branch].iter().any(|s| s.is_empty()) {
            return Err(invalid("Saved identity must be a non-empty string."));
        }
        token(operation)?;
        if let Some(expected) = expected {
            token(expected)?;
        }
        let transaction =
            rusqlite::Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)
                .map_err(sql_error)?;
        if self.simulation(owner, simulation)?.is_none()
            || self.branch(owner, simulation, branch)?.is_none()
        {
            return Err(EngineError {
                code: ErrorCode::NotFound,
                message: "Saved simulation or branch not found.".into(),
            });
        }
        let previous=self.connection.query_row("SELECT version,previous_version,simulation_id,branch_id,opened_at FROM application_navigation_version WHERE owner_scope=?",[owner],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?))).optional().map_err(sql_error)?;
        if let Some((version, prior, sim, b, opened)) = &previous
            && version == operation
        {
            if sim != simulation || b != branch || prior.as_deref() != expected {
                return Err(EngineError::command_conflict(operation));
            }
            return Ok(json!({"version":operation,"openedAt":opened}));
        }
        if previous.as_ref().map(|p| p.0.as_str()) != expected {
            return Err(invalid(
                "Resume location changed in another entry. This entry was not saved.",
            ));
        }
        let timestamp = Utc::now().timestamp_millis().max(
            previous
                .as_ref()
                .map(|p| {
                    chrono::DateTime::parse_from_rfc3339(&p.4)
                        .map(|d| d.timestamp_millis() + 1)
                        .map_err(|_| invalid("Saved navigation clock is invalid."))
                })
                .transpose()?
                .unwrap_or(0),
        );
        let opened = chrono::DateTime::from_timestamp_millis(timestamp)
            .ok_or_else(|| invalid("Saved navigation clock is invalid."))?
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        transaction.execute("INSERT INTO application_navigation_version VALUES (?,?,?,?,?,?) ON CONFLICT(owner_scope) DO UPDATE SET version=excluded.version,previous_version=excluded.previous_version,simulation_id=excluded.simulation_id,branch_id=excluded.branch_id,opened_at=excluded.opened_at",params![owner,operation,expected,simulation,branch,opened]).map_err(sql_error)?;
        transaction.execute("INSERT INTO application_simulation_navigation VALUES (?,?,?,?) ON CONFLICT(owner_scope,simulation_id) DO UPDATE SET branch_id=excluded.branch_id,opened_at=excluded.opened_at",params![owner,simulation,branch,opened]).map_err(sql_error)?;
        transaction.commit().map_err(sql_error)?;
        Ok(json!({"version":operation,"openedAt":opened}))
    }
}
