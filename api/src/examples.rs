use crate::{
    application::{StartRequest, start_from_source},
    error::{EngineError, Result},
    identity::domain_id,
    ports::SimulationRepository,
    safe_fs::TempDirectory,
    source,
};
use serde_json::{Value, json};
use std::path::Path;
const SIMULATION: &str = "example-last-crossing";
const COMMAND: &str = "example-last-crossing-start-v1";
fn resume(repository: &impl SimulationRepository) -> Result<Option<Value>> {
    let Some(simulation) = repository.simulation("local", SIMULATION)? else {
        return Ok(None);
    };
    let root = repository.commit(
        "local",
        SIMULATION,
        &domain_id("commit", &["local", SIMULATION, COMMAND]),
    )?;
    if simulation.scenario_id.as_deref() != Some("last-crossing")
        || root
            .as_ref()
            .is_none_or(|c| c.kind != "root" || c.command_id != COMMAND)
    {
        return Err(EngineError::command_conflict(
            "The example run identity is already in use by another simulation.",
        ));
    }
    Ok(Some(
        json!({"simulationId":SIMULATION,"branchId":simulation.default_branch_id,"workspacePath":simulation.source_root}),
    ))
}
pub fn play_last_crossing(
    repository: &mut impl SimulationRepository,
    local_directory: &Path,
) -> Result<Value> {
    if let Some(existing) = resume(repository)? {
        return Ok(existing);
    }
    let allocated = TempDirectory::create(local_directory, "last-crossing-")?;
    let workspace = allocated.path().join("source");
    let outcome = (|| {
        source::init(&workspace, Some("last-crossing"))?;
        if resume(repository)?.is_none() {
            let start = start_from_source(
                repository,
                StartRequest {
                    owner_scope: "local",
                    simulation_id: SIMULATION,
                    command_id: COMMAND,
                    scenario_id: Some("last-crossing".into()),
                    branch_id: Some("main".into()),
                },
                &workspace,
            );
            if let Err(error) = start
                && resume(repository)?.is_none()
            {
                return Err(error);
            }
        }
        resume(repository)?
            .ok_or_else(|| EngineError::invalid("The example did not create a saved simulation."))
    })();
    match repository.simulation("local", SIMULATION) {
        Ok(Some(simulation)) if simulation.source_root == workspace.to_string_lossy() => {
            allocated.retain();
        }
        Err(_) => {
            allocated.retain();
        } // Ownership is uncertain; preserve the allocation.
        _ => {}
    }
    outcome
}
