CREATE TABLE IF NOT EXISTS application_installation (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1), id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS saved_alternative_operations (
  owner_scope TEXT NOT NULL, simulation_id TEXT NOT NULL, id TEXT NOT NULL, record_json TEXT NOT NULL,
  PRIMARY KEY (owner_scope, simulation_id, id)
);
CREATE TABLE IF NOT EXISTS application_navigation_version (
  owner_scope TEXT PRIMARY KEY, version TEXT NOT NULL, previous_version TEXT,
  simulation_id TEXT NOT NULL, branch_id TEXT NOT NULL, opened_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS application_simulation_navigation (
  owner_scope TEXT NOT NULL, simulation_id TEXT NOT NULL, branch_id TEXT NOT NULL,
  opened_at TEXT NOT NULL, PRIMARY KEY(owner_scope, simulation_id)
);
CREATE TABLE IF NOT EXISTS content_revisions (
  id TEXT PRIMARY KEY, owner_scope TEXT NOT NULL, digest TEXT NOT NULL,
  compiled_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(owner_scope, digest)
);
CREATE TABLE IF NOT EXISTS branch_simulations (
  owner_scope TEXT NOT NULL, id TEXT NOT NULL, content_revision_id TEXT NOT NULL,
  source_root TEXT NOT NULL, scenario_id TEXT, default_branch_id TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY(owner_scope, id),
  FOREIGN KEY(content_revision_id) REFERENCES content_revisions(id)
);
CREATE TABLE IF NOT EXISTS commits (
  id TEXT PRIMARY KEY, owner_scope TEXT NOT NULL, simulation_id TEXT NOT NULL,
  parent_commit_id TEXT, kind TEXT NOT NULL, command_id TEXT NOT NULL,
  events_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(owner_scope, simulation_id, command_id),
  FOREIGN KEY(parent_commit_id) REFERENCES commits(id)
);
CREATE TABLE IF NOT EXISTS branches (
  id TEXT NOT NULL, owner_scope TEXT NOT NULL, simulation_id TEXT NOT NULL,
  name TEXT, head_commit_id TEXT NOT NULL, origin_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_scope, simulation_id, id),
  FOREIGN KEY(head_commit_id) REFERENCES commits(id)
);
CREATE TABLE IF NOT EXISTS command_results (
  owner_scope TEXT NOT NULL, simulation_id TEXT NOT NULL, command_id TEXT NOT NULL,
  canonical_input_json TEXT NOT NULL, fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(owner_scope, simulation_id, command_id)
);
CREATE TABLE IF NOT EXISTS draft_stage_whispers (
  id TEXT PRIMARY KEY, owner_scope TEXT NOT NULL, simulation_id TEXT NOT NULL,
  branch_id TEXT NOT NULL, expected_head TEXT NOT NULL, command_id TEXT NOT NULL,
  target_actor_id TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(owner_scope, simulation_id, command_id)
);
CREATE TABLE IF NOT EXISTS actor_turn_drafts (
  id TEXT PRIMARY KEY, owner_scope TEXT NOT NULL, simulation_id TEXT NOT NULL,
  generation_command_id TEXT NOT NULL, status TEXT NOT NULL,
  draft_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(owner_scope, simulation_id, generation_command_id)
);
CREATE TABLE IF NOT EXISTS actor_turn_draft_commands (
  owner_scope TEXT NOT NULL, simulation_id TEXT NOT NULL, command_id TEXT NOT NULL,
  kind TEXT NOT NULL, draft_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_scope, simulation_id, command_id),
  FOREIGN KEY(draft_id) REFERENCES actor_turn_drafts(id)
);
CREATE TABLE IF NOT EXISTS accepted_actor_turn_draft_identities (
  owner_scope TEXT NOT NULL, simulation_id TEXT NOT NULL,
  generation_command_id TEXT NOT NULL, draft_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_scope, simulation_id, generation_command_id),
  UNIQUE(owner_scope, simulation_id, draft_id)
);
CREATE INDEX IF NOT EXISTS actor_turn_draft_commands_by_draft
  ON actor_turn_draft_commands(owner_scope, simulation_id, draft_id);
CREATE TABLE IF NOT EXISTS memory_jobs (
  id TEXT PRIMARY KEY, owner_scope TEXT NOT NULL, simulation_id TEXT NOT NULL,
  origin_branch_id TEXT NOT NULL, episode_id TEXT NOT NULL,
  closure_commit_id TEXT NOT NULL UNIQUE, basis_head_commit_id TEXT NOT NULL,
  command_id TEXT NOT NULL, label TEXT, status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL, result_fingerprint TEXT, result_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(owner_scope, simulation_id, command_id),
  FOREIGN KEY(closure_commit_id) REFERENCES commits(id),
  FOREIGN KEY(basis_head_commit_id) REFERENCES commits(id)
);
CREATE TABLE IF NOT EXISTS detached_memory_operations (
  id TEXT PRIMARY KEY, owner_scope TEXT NOT NULL, simulation_id TEXT NOT NULL,
  job_id TEXT NOT NULL, operation_json TEXT NOT NULL,
  FOREIGN KEY(job_id) REFERENCES memory_jobs(id)
);
CREATE TABLE IF NOT EXISTS memory_job_transitions (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, owner_scope TEXT NOT NULL,
  simulation_id TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL,
  result_fingerprint TEXT, result_json TEXT, error TEXT, created_at TEXT NOT NULL,
  UNIQUE(job_id, attempt, status), FOREIGN KEY(job_id) REFERENCES memory_jobs(id)
);
