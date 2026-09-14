import { navigationToken, savedIdentity, type SimulationCollectionRepository, type SimulationCollectionItem, type RecordSimulationOpened, type NavigationReceipt } from "../application/simulation-collection.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { prepareCompiledRevision } from "../core/content-revision.ts";
import {
  assertRecordedCommandOutcome,
  assertRecordedOutcomeIdentity,
  decodeRecordedCommand,
  decodeRecordedOutcome,
} from "../core/recorded-codec.ts";
import { validateSimulationArchive } from "../core/archive-verifier.ts";
export { validateSimulationArchive } from "../core/archive-verifier.ts";
import {
  buildBranchOrigin,
  buildRootOrigin,
  domainId,
  fingerprintCommand,
  recordBranchOutcome,
  recordCommand,
  recordCommitOutcome,
  recordStartOutcome,
  recordWhisperOutcome,
  unwrapRecordedOutcome,
} from "../core/domain-rules.ts";
import {
  acceptedTextFromReceipt,
  buildAcceptedCommit,
  receiptFor,
  validateReadyDraft,
} from "../core/draft-acceptance.ts";
import { decodeActorTurnDraftRecord } from "../core/draft-contracts.ts";
import {
  BranchConflictError,
  CommandIdentityError,
  DomainNotFoundError,
  DomainValidationError,
  MemoryJobConflictError,
  type AppendCommitInput,
  type ClosureRequestInput,
  type CreateContentRevisionInput,
  type ActorTurnDraftRepository,
  type AcceptActorTurnDraftCommand,
  type CreateSimulationInput,
  type RecordedCommand,
  type RecordedOutcome,
  type SimulationArchive,
  type SimulationRepository,
  type StartSimulationInput,
  type StageWhisperCommand,
} from "../core/ports.ts";
import type {
  BranchRecord,
  CommitRecord,
  CompiledWorkspace,
  ContentRevisionRecord,
  SimulationRecord,
  StageWhisperRecord,
  ActorTurnDraftArtifact,
  ActorTurnDraftFailure,
  ActorTurnDraftRecord,
  MemoryJobRecord,
  MemoryOperation,
  MemoryJobResult,
  MemoryJobTransition,
} from "../core/types.ts";

export function openBranchStore(
  dbPath = ".doxvelt/runtime.sqlite",
): SqliteSimulationRepository {
  return new SqliteSimulationRepository(path.resolve(dbPath));
}

export class SqliteSimulationRepository
  implements SimulationRepository, ActorTurnDraftRepository, SimulationCollectionRepository {
  private db: DatabaseSync | null = null;
  readonly dbPath: string;
  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async open(): Promise<this> {
    await mkdir(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(
      "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;",
    );
    this.db.exec(`
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
    `);
    const jobColumns = this.db.prepare("PRAGMA table_info(memory_jobs)").all() as Array<{ name: string }>;
    if (!jobColumns.some((column) => column.name === "result_json"))
      this.db.exec("ALTER TABLE memory_jobs ADD COLUMN result_json TEXT");
    return this;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  createContentRevision({
    ownerScope,
    compiled,
  }: CreateContentRevisionInput): ContentRevisionRecord {
    compiled = prepareCompiledRevision(compiled);
    const digest = hash(stableStringify({ ...compiled, sourceRoot: "" }));
    return this.transaction(() => {
      const existing = this.sql()
        .prepare(
          "SELECT * FROM content_revisions WHERE owner_scope = ? AND digest = ?",
        )
        .get(ownerScope, digest);
      if (existing) return rowToRevision(existing);
      const revision: ContentRevisionRecord = {
        id: `rev_${randomUUID()}`,
        ownerScope,
        digest,
        compiled,
        createdAt: now(),
      };
      this.sql()
        .prepare("INSERT INTO content_revisions VALUES (?, ?, ?, ?, ?)")
        .run(
          revision.id,
          ownerScope,
          digest,
          JSON.stringify(compiled),
          revision.createdAt,
        );
      return revision;
    });
  }

  getContentRevision(
    ownerScope: string,
    revisionId: string,
  ): ContentRevisionRecord | null {
    const row = this.sql()
      .prepare(
        "SELECT * FROM content_revisions WHERE owner_scope = ? AND id = ?",
      )
      .get(ownerScope, revisionId);
    return row ? rowToRevision(row) : null;
  }

  createSimulation(input: CreateSimulationInput): {
    simulation: SimulationRecord;
    branch: BranchRecord;
    root: CommitRecord;
  } {
    const command = recordCommand("start", input);
    const fingerprint = fingerprintCommand(command);
    const revision = this.getContentRevision(
      input.ownerScope,
      input.contentRevisionId,
    );
    if (!revision)
      throw new Error(`Content revision not found: ${input.contentRevisionId}`);
    const createdAt = now();
    const simulation: SimulationRecord = {
      id: input.simulationId,
      ownerScope: input.ownerScope,
      contentRevisionId: revision.id,
      sourceRoot: input.sourceRoot,
      scenarioId: input.scenarioId,
      defaultBranchId: input.defaultBranchId,
      createdAt,
    };
    const root: CommitRecord = {
      id: input.rootCommitId,
      ownerScope: input.ownerScope,
      simulationId: input.simulationId,
      parentCommitId: null,
      kind: "root",
      commandId: input.commandId,
      events: [],
      createdAt,
    };
    const branch: BranchRecord = {
      id: input.defaultBranchId,
      ownerScope: input.ownerScope,
      simulationId: input.simulationId,
      name: "main",
      headCommitId: root.id,
      origin: buildRootOrigin(input.commandId, root.id),
      createdAt,
    };
    const result = { simulation, branch, root };
    return this.transaction(() => {
      const prior = this.readCommand(
        input.ownerScope,
        input.simulationId,
        input.commandId,
        fingerprint,
      );
      if (prior)
        return unwrapRecordedOutcome(prior) as {
          simulation: SimulationRecord;
          branch: BranchRecord;
          root: CommitRecord;
        };
      this.sql()
        .prepare("INSERT INTO branch_simulations VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          input.ownerScope,
          input.simulationId,
          revision.id,
          input.sourceRoot,
          input.scenarioId,
          branch.id,
          createdAt,
        );
      this.insertCommit(root);
      this.sql()
        .prepare("INSERT INTO branches VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          branch.id,
          branch.ownerScope,
          branch.simulationId,
          branch.name,
          branch.headCommitId,
          JSON.stringify(branch.origin),
          branch.createdAt,
        );
      this.writeCommand(
        input.ownerScope,
        input.simulationId,
        input.commandId,
        command,
        fingerprint,
        recordStartOutcome(result),
      );
      return result;
    });
  }

  startSimulation(input: StartSimulationInput): {
    simulation: SimulationRecord;
    branch: BranchRecord;
    root: CommitRecord;
    contentRevision: ContentRevisionRecord;
  } {
    const compiled = prepareCompiledRevision(input.compiled);
    const digest = hash(stableStringify(compiled));
    const command = recordCommand("start", { ...input, compiled });
    const fingerprint = fingerprintCommand(command);
    return this.transaction(() => {
      const prior = this.readCommand(
        input.ownerScope,
        input.simulationId,
        input.commandId,
        fingerprint,
      );
      if (prior) {
        return unwrapRecordedOutcome(prior) as {
          simulation: SimulationRecord;
          branch: BranchRecord;
          root: CommitRecord;
          contentRevision: ContentRevisionRecord;
        };
      }

      let contentRevision = this.findContentRevision(input.ownerScope, digest);
      if (!contentRevision) {
        contentRevision = this.insertContentRevision(
          input.ownerScope,
          compiled,
          digest,
        );
      }

      const createdAt = now();
      const simulation: SimulationRecord = {
        id: input.simulationId,
        ownerScope: input.ownerScope,
        contentRevisionId: contentRevision.id,
        sourceRoot: input.sourceRoot,
        scenarioId: input.scenarioId,
        defaultBranchId: input.defaultBranchId,
        createdAt,
      };
      const root: CommitRecord = {
        id: input.rootCommitId,
        ownerScope: input.ownerScope,
        simulationId: input.simulationId,
        parentCommitId: null,
        kind: "root",
        commandId: input.commandId,
        events: [],
        createdAt,
      };
      const branch: BranchRecord = {
        id: input.defaultBranchId,
        ownerScope: input.ownerScope,
        simulationId: input.simulationId,
        name: "main",
        headCommitId: root.id,
        origin: buildRootOrigin(input.commandId, root.id),
        createdAt,
      };
      this.sql()
        .prepare("INSERT INTO branch_simulations VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          simulation.ownerScope,
          simulation.id,
          simulation.contentRevisionId,
          simulation.sourceRoot,
          simulation.scenarioId,
          simulation.defaultBranchId,
          simulation.createdAt,
        );
      this.insertCommit(root);
      this.sql()
        .prepare("INSERT INTO branches VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          branch.id,
          branch.ownerScope,
          branch.simulationId,
          branch.name,
          branch.headCommitId,
          JSON.stringify(branch.origin),
          branch.createdAt,
        );
      const result = { simulation, branch, root, contentRevision };
      this.writeCommand(
        input.ownerScope,
        input.simulationId,
        input.commandId,
        command,
        fingerprint,
        recordStartOutcome(result),
      );
      return result;
    });
  }

  listSimulations(ownerScope: string): SimulationCollectionItem[] {
    savedIdentity(ownerScope);
    // Extract only the pinned label in SQL; collection transport never carries content.
    return this.sql().prepare(`
      SELECT s.id AS simulationId,
        (SELECT json_extract(scenario.value, '$.name')
         FROM json_each(r.compiled_json, '$.scenarios') AS scenario
         WHERE json_extract(scenario.value, '$.id') = s.scenario_id LIMIT 1) AS scenarioName,
        s.created_at AS createdAt, n.opened_at AS openedAt,
        COALESCE(n.branch_id, s.default_branch_id) AS branchId
      FROM branch_simulations s
      JOIN content_revisions r ON r.id = s.content_revision_id AND r.owner_scope = s.owner_scope
      LEFT JOIN application_simulation_navigation n ON n.owner_scope = s.owner_scope AND n.simulation_id = s.id
      WHERE s.owner_scope = ?
      ORDER BY (n.opened_at IS NOT NULL) DESC, n.opened_at DESC, s.created_at DESC, s.id COLLATE BINARY ASC
    `).all(ownerScope) as SimulationCollectionItem[];
  }

  getNavigationVersion(ownerScope: string): string | null {
    savedIdentity(ownerScope);
    const row = this.sql().prepare("SELECT version FROM application_navigation_version WHERE owner_scope = ?").get(ownerScope);
    return row ? String(row.version) : null;
  }

  recordSimulationOpened(input: RecordSimulationOpened): NavigationReceipt {
    for (const id of [input.ownerScope, input.simulationId, input.branchId]) savedIdentity(id);
    navigationToken(input.operationId);
    if (input.expectedVersion !== null) navigationToken(input.expectedVersion);
    return this.transaction(() => {
      if (!this.getSimulation(input.ownerScope, input.simulationId) || !this.getBranch(input.ownerScope, input.simulationId, input.branchId))
        throw new DomainNotFoundError("Saved simulation or branch not found.");
      const previous = this.sql().prepare("SELECT * FROM application_navigation_version WHERE owner_scope = ?").get(input.ownerScope);
      if (previous?.version === input.operationId) {
        if (previous.simulation_id !== input.simulationId || previous.branch_id !== input.branchId || previous.previous_version !== input.expectedVersion)
          throw new CommandIdentityError(input.operationId);
        return { version: input.operationId, openedAt: String(previous.opened_at) };
      }
      if ((previous?.version ?? null) !== input.expectedVersion)
        throw new DomainValidationError("Resume location changed in another entry. This entry was not saved.");
      // Server time; preserve strict ordering even for two writes in the same millisecond.
      const openedAt = new Date(Math.max(Date.now(), previous ? Date.parse(String(previous.opened_at)) + 1 : 0)).toISOString();
      this.sql().prepare(`INSERT INTO application_navigation_version VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_scope) DO UPDATE SET version=excluded.version, previous_version=excluded.previous_version,
        simulation_id=excluded.simulation_id, branch_id=excluded.branch_id, opened_at=excluded.opened_at`)
        .run(input.ownerScope, input.operationId, input.expectedVersion, input.simulationId, input.branchId, openedAt);
      this.sql().prepare(`INSERT INTO application_simulation_navigation VALUES (?, ?, ?, ?)
        ON CONFLICT(owner_scope, simulation_id) DO UPDATE SET branch_id=excluded.branch_id, opened_at=excluded.opened_at`)
        .run(input.ownerScope, input.simulationId, input.branchId, openedAt);
      return { version: input.operationId, openedAt };
    });
  }

  getSimulation(
    ownerScope: string,
    simulationId: string,
  ): SimulationRecord | null {
    const row = this.sql()
      .prepare(
        "SELECT * FROM branch_simulations WHERE owner_scope = ? AND id = ?",
      )
      .get(ownerScope, simulationId);
    return row ? rowToSimulation(row) : null;
  }

  getBranch(
    ownerScope: string,
    simulationId: string,
    branchId: string,
  ): BranchRecord | null {
    const row = this.sql()
      .prepare(
        "SELECT * FROM branches WHERE owner_scope = ? AND simulation_id = ? AND id = ?",
      )
      .get(ownerScope, simulationId, branchId);
    return row ? rowToBranch(row) : null;
  }

  getCommit(
    ownerScope: string,
    simulationId: string,
    commitId: string,
  ): CommitRecord | null {
    const row = this.sql()
      .prepare(
        "SELECT * FROM commits WHERE owner_scope = ? AND simulation_id = ? AND id = ?",
      )
      .get(ownerScope, simulationId, commitId);
    return row ? rowToCommit(row) : null;
  }

  listAncestors(
    ownerScope: string,
    simulationId: string,
    headCommitId: string,
  ): CommitRecord[] {
    const commits: CommitRecord[] = [];
    const seen = new Set<string>();
    let cursor: string | null = headCommitId;
    while (cursor) {
      if (seen.has(cursor))
        throw new Error(`Commit ancestry cycle at ${cursor}`);
      seen.add(cursor);
      const commit = this.getCommit(ownerScope, simulationId, cursor);
      if (!commit)
        throw new Error(`Commit not found in simulation ancestry: ${cursor}`);
      commits.push(commit);
      cursor = commit.parentCommitId;
    }
    return commits.reverse();
  }

  appendCommit(input: AppendCommitInput): {
    branch: BranchRecord;
    commit: CommitRecord;
    replayed: boolean;
  } {
    const { commit } = input;
    const fingerprint = input.commandFingerprint;
    return this.transaction(() => {
      const prior = this.readCommand(
        commit.ownerScope,
        commit.simulationId,
        commit.commandId,
        fingerprint,
      );
      if (prior)
        return {
          ...(unwrapRecordedOutcome(prior) as {
            branch: BranchRecord;
            commit: CommitRecord;
          }),
          replayed: true,
        };
      const branch = this.getBranch(
        commit.ownerScope,
        commit.simulationId,
        input.branchId,
      );
      if (!branch) throw new Error(`Branch not found: ${input.branchId}`);
      if (branch.headCommitId !== input.expectedHead)
        throw new BranchConflictError(input.expectedHead, branch.headCommitId);
      if (commit.parentCommitId !== input.expectedHead)
        throw new Error("Commit parent must equal the expected branch head.");
      this.insertCommit(commit);
      const changed = this.sql()
        .prepare(
          "UPDATE branches SET head_commit_id = ? WHERE owner_scope = ? AND simulation_id = ? AND id = ? AND head_commit_id = ?",
        )
        .run(
          commit.id,
          commit.ownerScope,
          commit.simulationId,
          input.branchId,
          input.expectedHead,
        );
      if (changed.changes !== 1)
        throw new BranchConflictError(
          input.expectedHead,
          this.getBranch(commit.ownerScope, commit.simulationId, input.branchId)
            ?.headCommitId || "missing",
        );
      const result = { branch: { ...branch, headCommitId: commit.id }, commit };
      this.writeCommand(
        commit.ownerScope,
        commit.simulationId,
        commit.commandId,
        input.commandInput,
        fingerprint,
        recordCommitOutcome(result),
      );
      return { ...result, replayed: false };
    });
  }

  requestClosure(input: ClosureRequestInput) {
    return this.transaction(() => {
      const prior = this.readCommand(input.commit.ownerScope, input.commit.simulationId,
        input.commit.commandId, input.commandFingerprint);
      if (prior) {
        const result = unwrapRecordedOutcome(prior) as { branch: BranchRecord; commit: CommitRecord };
        const job = this.getMemoryJob(input.commit.ownerScope, input.commit.simulationId, input.job.id);
        if (!job) throw new Error("Replayed closure has no memory job.");
        return { ...result, job, replayed: true };
      }
      const branch = this.getBranch(input.commit.ownerScope, input.commit.simulationId, input.branchId);
      if (!branch) throw new DomainNotFoundError(`Branch not found: ${input.branchId}`);
      if (branch.headCommitId !== input.expectedHead)
        throw new BranchConflictError(input.expectedHead, branch.headCommitId);
      if (input.commit.parentCommitId !== input.expectedHead)
        throw new Error("Commit parent must equal the expected branch head.");
      this.insertCommit(input.commit);
      const changed = this.sql().prepare("UPDATE branches SET head_commit_id = ? WHERE owner_scope = ? AND simulation_id = ? AND id = ? AND head_commit_id = ?")
        .run(input.commit.id, input.commit.ownerScope, input.commit.simulationId, input.branchId, input.expectedHead);
      if (changed.changes !== 1)
        throw new BranchConflictError(
          input.expectedHead,
          this.getBranch(
            input.commit.ownerScope,
            input.commit.simulationId,
            input.branchId,
          )?.headCommitId || "missing",
        );
      this.insertMemoryJob(input.job);
      const result = { branch: { ...branch, headCommitId: input.commit.id }, commit: input.commit };
      this.writeCommand(input.commit.ownerScope, input.commit.simulationId, input.commit.commandId,
        input.commandInput, input.commandFingerprint, recordCommitOutcome(result));
      return { ...result, job: input.job, replayed: false };
    });
  }

  getMemoryJob(ownerScope: string, simulationId: string, jobId: string): MemoryJobRecord | null {
    const row = this.sql().prepare("SELECT * FROM memory_jobs WHERE owner_scope = ? AND simulation_id = ? AND id = ?")
      .get(ownerScope, simulationId, jobId);
    return row ? deriveMemoryJob(rowToMemoryJob(row), this.listMemoryJobTransitions(
      ownerScope, simulationId, jobId,
    )) : null;
  }
  listMemoryJobs(ownerScope: string, simulationId: string): MemoryJobRecord[] {
    return this.sql().prepare("SELECT * FROM memory_jobs WHERE owner_scope = ? AND simulation_id = ? ORDER BY created_at, id")
      .all(ownerScope, simulationId).map((row: any) => deriveMemoryJob(
        rowToMemoryJob(row), this.listMemoryJobTransitions(ownerScope, simulationId, row.id),
      ));
  }
  listMemoryJobTransitions(
    ownerScope: string, simulationId: string, jobId?: string,
  ): MemoryJobTransition[] {
    const where = jobId ? " AND job_id = ?" : "";
    const values = jobId ? [ownerScope, simulationId, jobId] : [ownerScope, simulationId];
    return this.sql().prepare(`SELECT * FROM memory_job_transitions
      WHERE owner_scope = ? AND simulation_id = ?${where}
      ORDER BY job_id, attempt, CASE status WHEN 'running' THEN 0 ELSE 1 END,
               created_at, id`)
      .all(...values).map(rowToMemoryJobTransition);
  }
  listDetachedMemoryOperations(ownerScope: string, simulationId: string): MemoryOperation[] {
    return this.sql().prepare("SELECT operation_json FROM detached_memory_operations WHERE owner_scope = ? AND simulation_id = ? ORDER BY rowid")
      .all(ownerScope, simulationId).map((row: any) => JSON.parse(row.operation_json));
  }
  startMemoryJob(ownerScope: string, simulationId: string, jobId: string): MemoryJobRecord {
    return this.transaction(() => {
      const job = this.getMemoryJob(ownerScope, simulationId, jobId);
      if (!job) throw new DomainNotFoundError(`Memory job not found: ${jobId}`);
      if (job.status === "completed") return job;
      if (job.status === "running") throw new MemoryJobConflictError(jobId);
      const attempt = job.attemptCount + 1;
      this.insertMemoryJobTransition({
        id: domainId("memory_job_transition", job.id, String(attempt), "running"),
        jobId: job.id, ownerScope, simulationId, attempt, status: "running",
        resultFingerprint: null, result: null, error: null, createdAt: now(),
      });
      return this.getMemoryJob(ownerScope, simulationId, jobId)!;
    });
  }
  completeMemoryJob(job: MemoryJobRecord, result: MemoryJobResult, resultFingerprint: string): MemoryJobRecord {
    return this.transaction(() => {
      const current = this.getMemoryJob(job.ownerScope, job.simulationId, job.id);
      if (!current) throw new DomainNotFoundError(`Memory job not found: ${job.id}`);
      if (current.status === "completed") return current;
      if (current.status !== "running") throw new DomainValidationError(`Memory job is not running: ${job.id}`);
      for (const operation of result.memoryOperations || [])
        this.sql().prepare("INSERT INTO detached_memory_operations VALUES (?, ?, ?, ?, ?)")
          .run(operation.id, job.ownerScope, job.simulationId, job.id, JSON.stringify(operation));
      this.insertMemoryJobTransition({
        id: domainId("memory_job_transition", job.id, String(current.attemptCount), "completed"),
        jobId: job.id, ownerScope: job.ownerScope, simulationId: job.simulationId,
        attempt: current.attemptCount, status: "completed", resultFingerprint,
        result: structuredClone(result), error: null, createdAt: now(),
      });
      return this.getMemoryJob(job.ownerScope, job.simulationId, job.id)!;
    });
  }
  failMemoryJob(job: MemoryJobRecord, error: string): MemoryJobRecord {
    return this.transaction(() => {
      const current = this.getMemoryJob(job.ownerScope, job.simulationId, job.id);
      if (!current) throw new DomainNotFoundError(`Memory job not found: ${job.id}`);
      if (current.status !== "running")
        throw new DomainValidationError(`Memory job is not running: ${job.id}`);
      this.insertMemoryJobTransition({
        id: domainId("memory_job_transition", job.id, String(current.attemptCount), "failed"),
        jobId: job.id, ownerScope: job.ownerScope, simulationId: job.simulationId,
        attempt: current.attemptCount, status: "failed", resultFingerprint: null,
        result: null, error: safeMemoryJobError(error), createdAt: now(),
      });
      return this.getMemoryJob(job.ownerScope, job.simulationId, job.id)!;
    });
  }

  createBranch(input: {
    ownerScope: string;
    simulationId: string;
    sourceBranchId: string;
    expectedHead: string;
    branchId: string;
    name?: string | null;
    atCommitId: string;
    commandId: string;
  }): { branch: BranchRecord; replayed: boolean } {
    const command = recordCommand("fork", input);
    const fingerprint = fingerprintCommand(command);
    const branch: BranchRecord = {
      id: input.branchId,
      ownerScope: input.ownerScope,
      simulationId: input.simulationId,
      name: input.name || null,
      headCommitId: input.atCommitId,
      origin: buildBranchOrigin({
        kind: "fork",
        commandId: input.commandId,
        sourceBranchId: input.sourceBranchId,
        sourceHeadCommitId: input.expectedHead,
        baseCommitId: input.atCommitId,
      }),
      createdAt: now(),
    };
    return this.transaction(() => {
      const prior = this.readCommand(
        input.ownerScope,
        input.simulationId,
        input.commandId,
        fingerprint,
      );
      if (prior)
        return {
          branch: (unwrapRecordedOutcome(prior) as { branch: BranchRecord }).branch,
          replayed: true,
        };
      const source = this.getBranch(
        input.ownerScope,
        input.simulationId,
        input.sourceBranchId,
      );
      if (!source)
        throw new DomainNotFoundError(
          `Source branch not found: ${input.sourceBranchId}`,
        );
      if (source.headCommitId !== input.expectedHead)
        throw new BranchConflictError(input.expectedHead, source.headCommitId);
      if (
        !this.listAncestors(
          input.ownerScope,
          input.simulationId,
          source.headCommitId,
        ).some((item) => item.id === input.atCommitId)
      )
        throw new DomainValidationError(
          `Fork commit ${input.atCommitId} is not on source branch ${input.sourceBranchId}.`,
        );
      this.sql()
        .prepare("INSERT INTO branches VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          branch.id,
          branch.ownerScope,
          branch.simulationId,
          branch.name,
          branch.headCommitId,
          JSON.stringify(branch.origin),
          branch.createdAt,
        );
      this.writeCommand(
        input.ownerScope,
        input.simulationId,
        input.commandId,
        command,
        fingerprint,
        recordBranchOutcome(branch),
      );
      return { branch, replayed: false };
    });
  }

  appendCommitToNewBranch(input: {
    sourceBranchId: string;
    expectedHead: string;
    branchId: string;
    name?: string | null;
    atCommitId: string;
    originKind: "edit" | "regenerate";
    commandInput: RecordedCommand;
    commandFingerprint: string;
    commit: CommitRecord;
  }): { branch: BranchRecord; commit: CommitRecord; replayed: boolean } {
    const { commit } = input;
    const fingerprint = input.commandFingerprint;
    return this.transaction(() => {
      const prior = this.readCommand(
        commit.ownerScope,
        commit.simulationId,
        commit.commandId,
        fingerprint,
      );
      if (prior)
        return {
          ...(unwrapRecordedOutcome(prior) as {
            branch: BranchRecord;
            commit: CommitRecord;
          }),
          replayed: true,
        };
      const source = this.getBranch(
        commit.ownerScope,
        commit.simulationId,
        input.sourceBranchId,
      );
      if (!source)
        throw new DomainNotFoundError(
          `Source branch not found: ${input.sourceBranchId}`,
        );
      if (source.headCommitId !== input.expectedHead)
        throw new BranchConflictError(input.expectedHead, source.headCommitId);
      if (
        !this.listAncestors(
          commit.ownerScope,
          commit.simulationId,
          source.headCommitId,
        ).some((item) => item.id === input.atCommitId)
      )
        throw new DomainValidationError(
          `Sibling parent ${input.atCommitId} is not on source branch ${input.sourceBranchId}.`,
        );
      if (commit.parentCommitId !== input.atCommitId)
        throw new Error(
          "Sibling commit parent does not match its branch point.",
        );
      this.insertCommit(commit);
      const branch: BranchRecord = {
        id: input.branchId,
        ownerScope: commit.ownerScope,
        simulationId: commit.simulationId,
        name: input.name || null,
        headCommitId: commit.id,
        origin: buildBranchOrigin({
          kind: input.originKind,
          commandId: commit.commandId,
          sourceBranchId: input.sourceBranchId,
          sourceHeadCommitId: input.expectedHead,
          baseCommitId: input.atCommitId,
        }),
        createdAt: commit.createdAt,
      };
      this.sql()
        .prepare("INSERT INTO branches VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          branch.id,
          branch.ownerScope,
          branch.simulationId,
          branch.name,
          branch.headCommitId,
          JSON.stringify(branch.origin),
          branch.createdAt,
        );
      const result = { branch, commit };
      this.writeCommand(
        commit.ownerScope,
        commit.simulationId,
        commit.commandId,
        input.commandInput,
        fingerprint,
        recordCommitOutcome(result),
      );
      return { ...result, replayed: false };
    });
  }

  exportSimulation(
    ownerScope: string,
    simulationId: string,
  ): SimulationArchive {
    const simulation = this.getSimulation(ownerScope, simulationId);
    if (!simulation) throw new Error(`Simulation not found: ${simulationId}`);
    const contentRevision = this.getContentRevision(
      ownerScope,
      simulation.contentRevisionId,
    );
    if (!contentRevision)
      throw new Error(
        `Content revision not found: ${simulation.contentRevisionId}`,
      );
    const branches = this.sql()
      .prepare(
        "SELECT * FROM branches WHERE owner_scope = ? AND simulation_id = ? ORDER BY created_at, id",
      )
      .all(ownerScope, simulationId)
      .map(rowToBranch);
    const commits = this.sql()
      .prepare(
        "SELECT * FROM commits WHERE owner_scope = ? AND simulation_id = ? ORDER BY created_at, id",
      )
      .all(ownerScope, simulationId)
      .map(rowToCommit);
    const commandResults = this.sql()
      .prepare(
        `SELECT command_id, canonical_input_json, fingerprint, result_json,
                created_at FROM command_results
         WHERE owner_scope = ? AND simulation_id = ?
         ORDER BY created_at, command_id`,
      )
      .all(ownerScope, simulationId)
      .map(decodeCommandRow);
    const stageWhispers = this.sql()
      .prepare(
        "SELECT * FROM draft_stage_whispers WHERE owner_scope = ? AND simulation_id = ? ORDER BY created_at, id",
      )
      .all(ownerScope, simulationId)
      .map(rowToStageWhisper);
    const memoryJobs = this.listMemoryJobs(ownerScope, simulationId);
    const memoryJobTransitions = this.listMemoryJobTransitions(ownerScope, simulationId);
    const detachedMemoryOperations = this.listDetachedMemoryOperations(ownerScope, simulationId);
    return {
      schemaVersion: 6,
      contentRevision,
      simulation,
      branches,
      commits,
      stageWhispers,
      commandResults,
      memoryJobs,
      memoryJobTransitions,
      detachedMemoryOperations,
    };
  }

  importSimulation(archive: SimulationArchive): void {
    validateSimulationArchive(archive);
    this.transaction(() => {
      const revision = archive.contentRevision;
      this.sql()
        .prepare("INSERT INTO content_revisions VALUES (?, ?, ?, ?, ?)")
        .run(
          revision.id,
          revision.ownerScope,
          revision.digest,
          JSON.stringify(revision.compiled),
          revision.createdAt,
        );
      const simulation = archive.simulation;
      this.sql()
        .prepare("INSERT INTO branch_simulations VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          simulation.ownerScope,
          simulation.id,
          simulation.contentRevisionId,
          simulation.sourceRoot,
          simulation.scenarioId,
          simulation.defaultBranchId,
          simulation.createdAt,
        );
      for (const commit of topologicalCommits(archive.commits))
        this.insertCommit(commit);
      for (const branch of archive.branches)
        this.sql()
          .prepare("INSERT INTO branches VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(
            branch.id,
            branch.ownerScope,
            branch.simulationId,
            branch.name,
            branch.headCommitId,
            JSON.stringify(branch.origin),
            branch.createdAt,
          );
      for (const whisper of archive.stageWhispers)
        this.insertStageWhisper(whisper);
      for (const command of archive.commandResults) {
        this.sql()
          .prepare("INSERT INTO command_results VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(
            archive.simulation.ownerScope,
            archive.simulation.id,
            command.commandId,
            JSON.stringify(command.canonicalInput),
            command.fingerprint,
            JSON.stringify(command.result),
            command.createdAt,
          );
        if (command.canonicalInput.kind === "accept_draft")
          this.reserveAcceptedDraftIdentity(
            archive.simulation.ownerScope,
            archive.simulation.id,
            command.canonicalInput.payload.generationCommandId,
            command.canonicalInput.payload.draftId,
            command.createdAt,
          );
      }
      for (const job of archive.memoryJobs || []) this.insertMemoryJob(job);
      for (const transition of archive.memoryJobTransitions || [])
        this.insertMemoryJobTransition(transition);
      for (const operation of archive.detachedMemoryOperations || []) {
        const job = archive.memoryJobs?.find((item) => item.closureCommitId === operation.closureCommitId);
        if (!job) throw new Error(`Detached memory operation has no job: ${operation.id}`);
        this.sql().prepare("INSERT INTO detached_memory_operations VALUES (?, ?, ?, ?, ?)")
          .run(operation.id, simulation.ownerScope, simulation.id, job.id, JSON.stringify(operation));
      }
    });
  }

  createStageWhisper(
    input: StageWhisperCommand,
  ): StageWhisperRecord {
    const command = recordCommand("whisper", input);
    const fingerprint = fingerprintCommand(command);
    const id = domainId(
      "whisper",
      input.ownerScope,
      input.simulationId,
      input.commandId,
    );
    const createdAt = now();
    const result: StageWhisperRecord = {
      id,
      ownerScope: input.ownerScope,
      simulationId: input.simulationId,
      branchId: input.branchId,
      expectedHead: input.expectedHead,
      commandId: input.commandId,
      targetActorId: input.targetActorId,
      text: input.text,
      createdAt,
    };
    return this.transaction(() => {
      const prior = this.readCommand(
        input.ownerScope,
        input.simulationId,
        input.commandId,
        fingerprint,
      );
      if (prior) return unwrapRecordedOutcome(prior) as StageWhisperRecord;
      const branch = this.getBranch(
        input.ownerScope,
        input.simulationId,
        input.branchId,
      );
      if (!branch) throw new Error(`Branch not found: ${input.branchId}`);
      if (branch.headCommitId !== input.expectedHead)
        throw new BranchConflictError(input.expectedHead, branch.headCommitId);
      this.sql()
        .prepare(
          `INSERT INTO draft_stage_whispers
            (id, owner_scope, simulation_id, branch_id, expected_head, command_id,
             target_actor_id, text, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.ownerScope,
          input.simulationId,
          input.branchId,
          input.expectedHead,
          input.commandId,
          input.targetActorId,
          input.text,
          createdAt,
        );
      this.writeCommand(
        input.ownerScope,
        input.simulationId,
        input.commandId,
        command,
        fingerprint,
        recordWhisperOutcome(result),
      );
      return result;
    });
  }

  listPendingStageWhispers(
    ownerScope: string,
    simulationId: string,
    branchId: string,
    expectedHead: string,
    targetActorId: string,
  ): StageWhisperRecord[] {
    const rows = this.sql()
      .prepare(
        "SELECT * FROM draft_stage_whispers WHERE owner_scope = ? AND simulation_id = ? AND branch_id = ? AND expected_head = ? AND target_actor_id = ? ORDER BY created_at, id",
      )
      .all(ownerScope, simulationId, branchId, expectedHead, targetActorId);
    return rows.map(rowToStageWhisper);
  }

  reserveActorTurnDraft(input: {
    draft: ActorTurnDraftRecord;
    commandFingerprint: string;
  }): { draft: ActorTurnDraftRecord; replayed: boolean } {
    return this.transaction(() => {
      const prior = this.readDraftCommand(
        input.draft.ownerScope,
        input.draft.simulationId,
        input.draft.generationCommandId,
        input.commandFingerprint,
      );
      if (prior) return { draft: prior, replayed: true };
      if (this.isAcceptedDraftId(
        input.draft.ownerScope,
        input.draft.simulationId,
        input.draft.id,
      ))
        throw new CommandIdentityError(input.draft.generationCommandId);
      const branch = this.getBranch(
        input.draft.ownerScope,
        input.draft.simulationId,
        input.draft.branchId,
      );
      if (!branch)
        throw new DomainNotFoundError(`Branch not found: ${input.draft.branchId}`);
      if (branch.headCommitId !== input.draft.basisHeadCommitId)
        throw new BranchConflictError(input.draft.basisHeadCommitId, branch.headCommitId);
      this.insertActorTurnDraft(input.draft);
      this.writeDraftCommand({
        ownerScope: input.draft.ownerScope,
        simulationId: input.draft.simulationId,
        commandId: input.draft.generationCommandId,
        kind: "generate",
        draftId: input.draft.id,
        fingerprint: input.commandFingerprint,
      });
      return { draft: input.draft, replayed: false };
    });
  }

  listRecoverableActorTurnDrafts(
    ownerScope: string,
    simulationId: string,
    branchId: string,
  ): ActorTurnDraftRecord[] {
    const rows = this.sql().prepare(
      `SELECT draft_json FROM actor_turn_drafts
       WHERE owner_scope = ? AND simulation_id = ?
         AND json_extract(draft_json, '$.branchId') = ?
         AND status IN ('generating', 'ready', 'failed')
       ORDER BY created_at, id`,
    ).all(ownerScope, simulationId, branchId) as { draft_json: string }[];
    return rows.map(rowToActorTurnDraft);
  }

  getActorTurnDraft(
    ownerScope: string,
    simulationId: string,
    draftId: string,
  ): ActorTurnDraftRecord | null {
    const row = this.sql().prepare(
      "SELECT draft_json FROM actor_turn_drafts WHERE owner_scope = ? AND simulation_id = ? AND id = ?",
    ).get(ownerScope, simulationId, draftId) as { draft_json: string } | undefined;
    return row ? rowToActorTurnDraft(row) : null;
  }

  completeActorTurnDraft(
    ownerScope: string,
    simulationId: string,
    draftId: string,
    artifact: ActorTurnDraftArtifact,
  ): ActorTurnDraftRecord {
    return this.transitionActorTurnDraft(ownerScope, simulationId, draftId, "ready", artifact, null);
  }

  failActorTurnDraft(
    ownerScope: string,
    simulationId: string,
    draftId: string,
    failure: ActorTurnDraftFailure,
  ): ActorTurnDraftRecord {
    return this.transitionActorTurnDraft(ownerScope, simulationId, draftId, "failed", null, failure);
  }

  discardActorTurnDraft(input: {
    ownerScope: string;
    simulationId: string;
    draftId: string;
    commandId: string;
    commandFingerprint: string;
  }): { draft: ActorTurnDraftRecord; replayed: boolean } {
    return this.transaction(() => {
      const prior = this.readDraftCommand(
        input.ownerScope,
        input.simulationId,
        input.commandId,
        input.commandFingerprint,
      );
      if (prior) return { draft: prior, replayed: true };
      const current = this.getActorTurnDraft(
        input.ownerScope,
        input.simulationId,
        input.draftId,
      );
      if (!current)
        throw new DomainNotFoundError(`Draft not found: ${input.draftId}`);
      if (current.generationCommandId === input.commandId)
        throw new DomainValidationError("Discard requires a distinct command ID.");
      if (current.status !== "generating" && current.status !== "ready" && current.status !== "failed")
        throw new DomainValidationError(`Draft cannot be discarded from ${current.status}.`);
      const draft = { ...current, status: "discarded" as const, updatedAt: now() };
      const changed = this.sql().prepare(
        "UPDATE actor_turn_drafts SET status = ?, draft_json = ?, updated_at = ? WHERE id = ? AND owner_scope = ? AND simulation_id = ? AND status IN ('generating', 'ready', 'failed')",
      ).run(draft.status, JSON.stringify(draft), draft.updatedAt, draft.id, draft.ownerScope, draft.simulationId);
      if (changed.changes !== 1)
        throw new DomainValidationError("Draft terminal transition lost its compare-and-set race.");
      this.writeDraftCommand({
        ownerScope: input.ownerScope,
        simulationId: input.simulationId,
        commandId: input.commandId,
        kind: "discard",
        draftId: input.draftId,
        fingerprint: input.commandFingerprint,
      });
      return { draft, replayed: false };
    });
  }
  replayAcceptedActorTurnDraft(
    input: AcceptActorTurnDraftCommand,
  ): { branch: BranchRecord; commit: CommitRecord } | null {
    const draftCommand = this.sql()
      .prepare(
        "SELECT 1 FROM actor_turn_draft_commands WHERE owner_scope = ? AND simulation_id = ? AND command_id = ?",
      )
      .get(input.ownerScope, input.simulationId, input.commandId);
    if (draftCommand) throw new CommandIdentityError(input.commandId);
    if (this.isAcceptedGenerationCommandId(
      input.ownerScope,
      input.simulationId,
      input.commandId,
    ))
      throw new CommandIdentityError(input.commandId);
    const row = this.sql()
      .prepare(
        "SELECT command_id, canonical_input_json, fingerprint, result_json, created_at FROM command_results WHERE owner_scope = ? AND simulation_id = ? AND command_id = ?",
      )
      .get(input.ownerScope, input.simulationId, input.commandId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const stored = decodeCommandRow(row);
    if (stored.canonicalInput.kind !== "accept_draft")
      throw new CommandIdentityError(input.commandId);
    const receipt = stored.canonicalInput.payload;
    if (receipt.draftId !== input.draftId)
      throw new CommandIdentityError(input.commandId);
    const expectedSource =
      input.finalText === undefined
        ? "generated_verbatim"
        : input.finalText === receipt.generatedArtifact.text
          ? "generated_verbatim"
          : "acceptor_edited";
    const finalText = acceptedTextFromReceipt(receipt);
    if (
      receipt.accepted.textSource !== expectedSource ||
      (input.finalText !== undefined && input.finalText !== finalText)
    )
      throw new CommandIdentityError(input.commandId);
    if (stored.result.kind !== "commit")
      throw new CommandIdentityError(input.commandId);
    validateSimulationArchive(
      this.exportSimulation(input.ownerScope, input.simulationId),
    );
    const commitId = domainId(
      "commit",
      input.ownerScope,
      input.simulationId,
      input.commandId,
    );
    const commitRow = this.sql()
      .prepare(
        "SELECT * FROM commits WHERE id = ? AND owner_scope = ? AND simulation_id = ?",
      )
      .get(commitId, input.ownerScope, input.simulationId);
    if (!commitRow)
      throw new DomainValidationError("Accepted draft commit is missing.");
    const commit = rowToCommit(commitRow);
    const branch = this.getBranch(
      input.ownerScope,
      input.simulationId,
      stored.canonicalInput.branchId,
    );
    if (!branch)
      throw new DomainValidationError("Accepted draft branch is missing.");
    const historicalBranch = { ...branch, headCommitId: commit.id };
    if (
      stableStringify(stored.result.commit) !== stableStringify(commit) ||
      stableStringify(stored.result.branch) !== stableStringify(historicalBranch)
    )
      throw new DomainValidationError(
        "Accepted draft result cache does not match authoritative history.",
      );
    return { branch: historicalBranch, commit };
  }

  acceptActorTurnDraft(input: {
    request: AcceptActorTurnDraftCommand;
    commandInput: Extract<RecordedCommand, { kind: "accept_draft" }>;
    commandFingerprint: string;
    createdAt: string;
  }): { branch: BranchRecord; commit: CommitRecord; replayed: boolean } {
    return this.transaction(() => {
      const replay = this.replayAcceptedActorTurnDraft(input.request);
      if (replay) return { ...replay, replayed: true };
      const collision = this.sql()
        .prepare(
          "SELECT 1 FROM actor_turn_draft_commands WHERE owner_scope = ? AND simulation_id = ? AND command_id = ?",
        )
        .get(
          input.request.ownerScope,
          input.request.simulationId,
          input.request.commandId,
        );
      if (collision) throw new CommandIdentityError(input.request.commandId);
      if (!validCreatedAt(input.createdAt))
        throw new DomainValidationError(
          "Draft acceptance timestamp is invalid.",
        );
      const draft = this.getActorTurnDraft(
        input.request.ownerScope,
        input.request.simulationId,
        input.request.draftId,
      );
      if (!draft) throw new DomainNotFoundError("Draft not found.");
      const validated = validateReadyDraft(this, input.request, draft);
      const receipt = receiptFor(validated.draft, validated.acceptedText);
      const expected = recordCommand("accept_draft", {
        ownerScope: input.request.ownerScope,
        simulationId: input.request.simulationId,
        branchId: validated.draft.branchId,
        expectedHead: validated.draft.basisHeadCommitId,
        commandId: input.request.commandId,
        payload: receipt,
      });
      if (
        stableStringify(input.commandInput) !== stableStringify(expected) ||
        input.commandFingerprint !== fingerprintCommand(expected)
      )
        throw new DomainValidationError(
          "Draft acceptance command is not bound to the validated draft.",
        );
      const commit = buildAcceptedCommit(
        this,
        validated.draft,
        receipt,
        input.request.commandId,
        input.createdAt,
      );
      this.insertCommit(commit);
      const changedHead = this.sql()
        .prepare(
          "UPDATE branches SET head_commit_id = ? WHERE owner_scope = ? AND simulation_id = ? AND id = ? AND head_commit_id = ?",
        )
        .run(
          commit.id,
          validated.draft.ownerScope,
          validated.draft.simulationId,
          validated.draft.branchId,
          validated.draft.basisHeadCommitId,
        );
      if (changedHead.changes !== 1)
        throw new BranchConflictError(
          validated.draft.basisHeadCommitId,
          this.getBranch(
            validated.draft.ownerScope,
            validated.draft.simulationId,
            validated.draft.branchId,
          )?.headCommitId || "missing",
        );
      const acceptedDraft = {
        ...validated.draft,
        status: "accepted" as const,
        updatedAt: now(),
      };
      const changedDraft = this.sql()
        .prepare(
          "UPDATE actor_turn_drafts SET status = ?, draft_json = ?, updated_at = ? WHERE id = ? AND owner_scope = ? AND simulation_id = ? AND status = 'ready'",
        )
        .run(
          acceptedDraft.status,
          JSON.stringify(acceptedDraft),
          acceptedDraft.updatedAt,
          acceptedDraft.id,
          acceptedDraft.ownerScope,
          acceptedDraft.simulationId,
        );
      if (changedDraft.changes !== 1)
        throw new DomainValidationError(
          "Draft terminal transition lost its compare-and-set race.",
        );
      const branch = this.getBranch(
        validated.draft.ownerScope,
        validated.draft.simulationId,
        validated.draft.branchId,
      )!;
      const result = { branch, commit };
      this.writeCommand(
        validated.draft.ownerScope,
        validated.draft.simulationId,
        input.request.commandId,
        expected,
        fingerprintCommand(expected),
        recordCommitOutcome(result),
      );
      this.reserveAcceptedDraftIdentity(
        validated.draft.ownerScope,
        validated.draft.simulationId,
        validated.draft.generationCommandId,
        validated.draft.id,
        input.createdAt,
      );
      return { ...result, replayed: false };
    });
  }

  replayCommand(
    ownerScope: string,
    simulationId: string,
    commandId: string,
    fingerprint: string,
  ): RecordedOutcome | null {
    return this.readCommand(ownerScope, simulationId, commandId, fingerprint);
  }

  private transitionActorTurnDraft(
    ownerScope: string,
    simulationId: string,
    draftId: string,
    status: "ready" | "failed",
    artifact: ActorTurnDraftArtifact | null,
    failure: ActorTurnDraftFailure | null,
  ): ActorTurnDraftRecord {
    return this.transaction(() => {
      const current = this.getActorTurnDraft(ownerScope, simulationId, draftId);
      if (!current) throw new DomainNotFoundError(`Draft not found: ${draftId}`);
      if (current.status !== "generating")
        throw new DomainValidationError(`Draft is not generating: ${draftId}`);
      const draft: ActorTurnDraftRecord = {
        ...current,
        status,
        artifact,
        failure,
        updatedAt: now(),
      };
      const changed = this.sql().prepare(
        "UPDATE actor_turn_drafts SET status = ?, draft_json = ?, updated_at = ? WHERE id = ? AND owner_scope = ? AND simulation_id = ? AND status = 'generating'",
      ).run(draft.status, JSON.stringify(draft), draft.updatedAt, draft.id, ownerScope, simulationId);
      if (changed.changes !== 1)
        throw new DomainValidationError("Draft terminal transition lost its compare-and-set race.");
      return draft;
    });
  }

  private insertActorTurnDraft(draft: ActorTurnDraftRecord): void {
    this.sql().prepare(
      "INSERT INTO actor_turn_drafts (id, owner_scope, simulation_id, generation_command_id, status, draft_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(draft.id, draft.ownerScope, draft.simulationId, draft.generationCommandId,
      draft.status, JSON.stringify(draft), draft.createdAt, draft.updatedAt);
  }

  private readDraftCommand(
    ownerScope: string,
    simulationId: string,
    commandId: string,
    fingerprint: string,
  ): ActorTurnDraftRecord | null {
    const canonical = this.sql().prepare(
      "SELECT 1 FROM command_results WHERE owner_scope = ? AND simulation_id = ? AND command_id = ?",
    ).get(ownerScope, simulationId, commandId);
    if (canonical) throw new CommandIdentityError(commandId);
    const row = this.sql().prepare(
      "SELECT fingerprint, draft_id FROM actor_turn_draft_commands WHERE owner_scope = ? AND simulation_id = ? AND command_id = ?",
    ).get(ownerScope, simulationId, commandId) as { fingerprint: string; draft_id: string } | undefined;
    if (row) {
      if (row.fingerprint !== fingerprint)
        throw new CommandIdentityError(commandId);
      const draft = this.getActorTurnDraft(ownerScope, simulationId, row.draft_id);
      if (!draft) throw new CommandIdentityError(commandId);
      return draft;
    }
    if (this.isAcceptedGenerationCommandId(ownerScope, simulationId, commandId))
      throw new CommandIdentityError(commandId);
    return null;
  }

  private reserveAcceptedDraftIdentity(
    ownerScope: string,
    simulationId: string,
    generationCommandId: string,
    draftId: string,
    createdAt: string,
  ): void {
    const existing = this.sql()
      .prepare(
        `SELECT generation_command_id, draft_id
           FROM accepted_actor_turn_draft_identities
          WHERE owner_scope = ? AND simulation_id = ?
            AND (generation_command_id = ? OR draft_id = ?)`,
      )
      .get(
        ownerScope,
        simulationId,
        generationCommandId,
        draftId,
      ) as { generation_command_id: string; draft_id: string } | undefined;
    if (existing) {
      if (
        existing.generation_command_id === generationCommandId &&
        existing.draft_id === draftId
      ) return;
      throw new CommandIdentityError(generationCommandId);
    }
    this.sql()
      .prepare(
        "INSERT INTO accepted_actor_turn_draft_identities VALUES (?, ?, ?, ?, ?)",
      )
      .run(ownerScope, simulationId, generationCommandId, draftId, createdAt);
  }

  private isAcceptedGenerationCommandId(
    ownerScope: string,
    simulationId: string,
    commandId: string,
  ): boolean {
    return Boolean(this.sql()
      .prepare(
        `SELECT 1 FROM accepted_actor_turn_draft_identities
          WHERE owner_scope = ? AND simulation_id = ?
            AND generation_command_id = ?`,
      )
      .get(ownerScope, simulationId, commandId));
  }

  private isAcceptedDraftId(
    ownerScope: string,
    simulationId: string,
    draftId: string,
  ): boolean {
    return Boolean(this.sql()
      .prepare(
        `SELECT 1 FROM accepted_actor_turn_draft_identities
          WHERE owner_scope = ? AND simulation_id = ? AND draft_id = ?`,
      )
      .get(ownerScope, simulationId, draftId));
  }

  private writeDraftCommand(input: {
    ownerScope: string;
    simulationId: string;
    commandId: string;
    kind: "generate" | "discard";
    draftId: string;
    fingerprint: string;
  }): void {
    this.sql().prepare(
      "INSERT INTO actor_turn_draft_commands VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(input.ownerScope, input.simulationId, input.commandId, input.kind,
      input.draftId, input.fingerprint, now());
  }

  private insertCommit(commit: CommitRecord): void {
    this.sql()
      .prepare("INSERT INTO commits VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        commit.id,
        commit.ownerScope,
        commit.simulationId,
        commit.parentCommitId,
        commit.kind,
        commit.commandId,
        JSON.stringify(commit.events),
        commit.createdAt,
      );
  }
  private insertMemoryJob(job: MemoryJobRecord): void {
    this.sql().prepare(`INSERT INTO memory_jobs
      (id, owner_scope, simulation_id, origin_branch_id, episode_id,
       closure_commit_id, basis_head_commit_id, command_id, label, status,
       attempt_count, result_fingerprint, result_json, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(job.id, job.ownerScope, job.simulationId, job.originBranchId, job.episodeId,
        job.closureCommitId, job.basisHeadCommitId, job.commandId, job.label, "pending",
        0, null, null, null, job.createdAt, job.createdAt);
  }
  private insertMemoryJobTransition(transition: MemoryJobTransition): void {
    this.sql().prepare("INSERT INTO memory_job_transitions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(transition.id, transition.jobId, transition.ownerScope,
        transition.simulationId, transition.attempt, transition.status,
        transition.resultFingerprint,
        transition.result ? JSON.stringify(transition.result) : null,
        transition.error, transition.createdAt);
  }
  private findContentRevision(
    ownerScope: string,
    digest: string,
  ): ContentRevisionRecord | null {
    const row = this.sql()
      .prepare(
        "SELECT * FROM content_revisions WHERE owner_scope = ? AND digest = ?",
      )
      .get(ownerScope, digest);
    return row ? rowToRevision(row) : null;
  }
  private insertContentRevision(
    ownerScope: string,
    compiled: CompiledWorkspace,
    digest: string,
  ): ContentRevisionRecord {
    const revision: ContentRevisionRecord = {
      id: `rev_${randomUUID()}`,
      ownerScope,
      digest,
      compiled,
      createdAt: now(),
    };
    this.sql()
      .prepare("INSERT INTO content_revisions VALUES (?, ?, ?, ?, ?)")
      .run(
        revision.id,
        ownerScope,
        digest,
        JSON.stringify(compiled),
        revision.createdAt,
      );
    return revision;
  }
  private insertStageWhisper(whisper: StageWhisperRecord): void {
    this.sql()
      .prepare(
        `INSERT INTO draft_stage_whispers
          (id, owner_scope, simulation_id, branch_id, expected_head, command_id,
           target_actor_id, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        whisper.id,
        whisper.ownerScope,
        whisper.simulationId,
        whisper.branchId,
        whisper.expectedHead,
        whisper.commandId,
        whisper.targetActorId,
        whisper.text,
        whisper.createdAt,
      );
  }
  private readCommand(
    ownerScope: string,
    simulationId: string,
    commandId: string,
    fingerprint: string,
  ): RecordedOutcome | null {
    const draftCommand = this.sql().prepare(
      "SELECT 1 FROM actor_turn_draft_commands WHERE owner_scope = ? AND simulation_id = ? AND command_id = ?",
    ).get(ownerScope, simulationId, commandId);
    if (draftCommand) throw new CommandIdentityError(commandId);
    if (this.isAcceptedGenerationCommandId(
      ownerScope,
      simulationId,
      commandId,
    ))
      throw new CommandIdentityError(commandId);
    const row = this.sql()
      .prepare(
        `SELECT command_id, canonical_input_json, fingerprint, result_json,
                created_at FROM command_results
         WHERE owner_scope = ? AND simulation_id = ? AND command_id = ?`,
      )
      .get(ownerScope, simulationId, commandId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const command = decodeCommandRow(row);
    if (command.fingerprint !== fingerprint)
      throw new CommandIdentityError(commandId);
    return command.result;
  }
  private writeCommand(
    ownerScope: string,
    simulationId: string,
    commandId: string,
    canonicalInput: RecordedCommand,
    fingerprint: string,
    result: RecordedOutcome,
  ): void {
    this.sql()
      .prepare("INSERT INTO command_results VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        ownerScope,
        simulationId,
        commandId,
        JSON.stringify(canonicalInput),
        fingerprint,
        JSON.stringify(result),
        now(),
      );
  }
  private transaction<T>(operation: () => T): T {
    this.sql().exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.sql().exec("COMMIT");
      return value;
    } catch (error) {
      this.sql().exec("ROLLBACK");
      throw error;
    }
  }
  private sql(): DatabaseSync {
    if (!this.db) throw new Error("Store is not open.");
    return this.db;
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  return value;
}
function now(): string {
  return new Date().toISOString();
}
function validCreatedAt(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}
function rowToRevision(row: any): ContentRevisionRecord {
  return {
    id: row.id,
    ownerScope: row.owner_scope,
    digest: row.digest,
    compiled: JSON.parse(row.compiled_json) as CompiledWorkspace,
    createdAt: row.created_at,
  };
}
function rowToSimulation(row: any): SimulationRecord {
  return {
    id: row.id,
    ownerScope: row.owner_scope,
    contentRevisionId: row.content_revision_id,
    sourceRoot: row.source_root,
    scenarioId: row.scenario_id,
    defaultBranchId: row.default_branch_id,
    createdAt: row.created_at,
  };
}
function rowToBranch(row: any): BranchRecord {
  return {
    id: row.id,
    ownerScope: row.owner_scope,
    simulationId: row.simulation_id,
    name: row.name,
    headCommitId: row.head_commit_id,
    origin: JSON.parse(row.origin_json),
    createdAt: row.created_at,
  };
}
function rowToCommit(row: any): CommitRecord {
  return {
    id: row.id,
    ownerScope: row.owner_scope,
    simulationId: row.simulation_id,
    parentCommitId: row.parent_commit_id,
    kind: row.kind,
    commandId: row.command_id,
    events: JSON.parse(row.events_json),
    createdAt: row.created_at,
  };
}
function rowToActorTurnDraft(row: {
  draft_json: string;
}): ActorTurnDraftRecord {
  return decodeActorTurnDraftRecord(JSON.parse(row.draft_json));
}
function rowToStageWhisper(row: any): StageWhisperRecord {
  return {
    id: row.id,
    ownerScope: row.owner_scope,
    simulationId: row.simulation_id,
    branchId: row.branch_id,
    expectedHead: row.expected_head,
    commandId: row.command_id,
    targetActorId: row.target_actor_id,
    text: row.text,
    createdAt: row.created_at,
  };
}
function rowToMemoryJob(row: any): MemoryJobRecord {
  return {
    id: row.id, ownerScope: row.owner_scope, simulationId: row.simulation_id,
    originBranchId: row.origin_branch_id, episodeId: row.episode_id,
    closureCommitId: row.closure_commit_id, basisHeadCommitId: row.basis_head_commit_id,
    commandId: row.command_id, label: row.label, status: row.status,
    attemptCount: row.attempt_count, resultFingerprint: row.result_fingerprint,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at,
  } as MemoryJobRecord;
}
function rowToMemoryJobTransition(row: any): MemoryJobTransition {
  return {
    id: row.id, jobId: row.job_id, ownerScope: row.owner_scope,
    simulationId: row.simulation_id, attempt: row.attempt, status: row.status,
    resultFingerprint: row.result_fingerprint,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error, createdAt: row.created_at,
  } as MemoryJobTransition;
}
function deriveMemoryJob(
  request: MemoryJobRecord,
  transitions: MemoryJobTransition[],
): MemoryJobRecord {
  const latest = transitions.at(-1);
  if (!latest) return { ...request, status: "pending", attemptCount: 0,
    resultFingerprint: null, result: null, lastError: null,
    updatedAt: request.createdAt };
  return {
    ...request, status: latest.status, attemptCount: latest.attempt,
    resultFingerprint: latest.resultFingerprint, result: latest.result,
    lastError: latest.error, updatedAt: latest.createdAt,
  };
}

function safeMemoryJobError(_error: string): string {
  return "Memory generation failed.";
}

function decodeCommandRow(row: any): SimulationArchive["commandResults"][number] {
  const canonicalInput = decodeRecordedCommand(
    JSON.parse(row.canonical_input_json),
  );
  const fingerprint = fingerprintCommand(canonicalInput);
  if (row.fingerprint !== fingerprint)
    throw new CommandIdentityError(String(row.command_id));
  const result = decodeRecordedOutcome(JSON.parse(row.result_json));
  assertRecordedCommandOutcome(canonicalInput, result);
  assertRecordedOutcomeIdentity(canonicalInput, result);
  return {
    commandId: stringColumn(row.command_id, "command ID"),
    canonicalInput,
    fingerprint,
    result,
    createdAt: stringColumn(row.created_at, "command timestamp"),
  };
}

function stringColumn(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid persisted ${label}.`);
  return value;
}
function topologicalCommits(commits: CommitRecord[]): CommitRecord[] {
  const pending = new Map(commits.map((item) => [item.id, item]));
  const ordered: CommitRecord[] = [];
  while (pending.size) {
    const ready = [...pending.values()].filter(
      (item) => !item.parentCommitId || !pending.has(item.parentCommitId),
    );
    if (!ready.length)
      throw new Error("Simulation archive contains cyclic commit ancestry.");
    for (const commit of ready) {
      ordered.push(commit);
      pending.delete(commit.id);
    }
  }
  return ordered;
}
