use crate::{
    access::assert_valid_graph,
    content::{CompiledWorkspace, compile_workspace},
    error::Result,
    identity::domain_id,
    model::{StartSimulation, StartedSimulation},
    ports::SimulationRepository,
};
use std::path::Path;

pub struct StartRequest<'a> {
    pub owner_scope: &'a str,
    pub simulation_id: &'a str,
    pub command_id: &'a str,
    pub scenario_id: Option<String>,
    pub branch_id: Option<String>,
}
pub fn start_from_source(
    repository: &mut impl SimulationRepository,
    request: StartRequest<'_>,
    workspace: &Path,
) -> Result<StartedSimulation> {
    start_from_compiled(repository, request, compile_workspace(workspace)?)
}
pub fn start_from_compiled(
    repository: &mut impl SimulationRepository,
    request: StartRequest<'_>,
    compiled: CompiledWorkspace,
) -> Result<StartedSimulation> {
    compiled.require_valid()?;
    assert_valid_graph(&compiled.access_links)?;
    let branch = request
        .branch_id
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| {
            domain_id(
                "branch",
                &[
                    request.owner_scope,
                    request.simulation_id,
                    request.command_id,
                ],
            )
        });
    repository.start_simulation(StartSimulation {
        owner_scope: request.owner_scope.into(),
        simulation_id: request.simulation_id.into(),
        command_id: request.command_id.into(),
        source_root: compiled.source_root.clone(),
        compiled: compiled.portable(),
        scenario_id: Some(request.scenario_id.unwrap_or_else(|| "default".into())),
        default_branch_id: branch,
        root_commit_id: domain_id(
            "commit",
            &[
                request.owner_scope,
                request.simulation_id,
                request.command_id,
            ],
        ),
    })
}
