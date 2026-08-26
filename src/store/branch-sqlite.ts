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
  BranchConflictError,
  CommandIdentityError,
  DomainNotFoundError,
  DomainValidationError,
  type AppendCommitInput,
  type CreateContentRevisionInput,
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
} from "../core/types.ts";

export function openBranchStore(
  dbPath = ".doxvelt/runtime.sqlite",
): SqliteSimulationRepository {
  return new SqliteSimulationRepository(path.resolve(dbPath));
}

export class SqliteSimulationRepository implements SimulationRepository {
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
    `);
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
    return {
      schemaVersion: 4,
      contentRevision,
      simulation,
      branches,
      commits,
      stageWhispers,
      commandResults,
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
      for (const command of archive.commandResults)
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

  replayCommand(
    ownerScope: string,
    simulationId: string,
    commandId: string,
    fingerprint: string,
  ): RecordedOutcome | null {
    return this.readCommand(ownerScope, simulationId, commandId, fingerprint);
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
