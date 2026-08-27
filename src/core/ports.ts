import type {
  BranchRecord,
  CommitRecord,
  CompiledWorkspace,
  ContentRevisionRecord,
  SimulationRecord,
  StageWhisperRecord,
} from "./types.ts";

export type ManualTurnPayload = {
  actorId: string;
  text: string;
  audience: string[];
  logicalMessageId?: string;
  operation?: "turn" | "edit" | "regenerate";
  audienceChanges?: Array<{
    actorId: string;
    action: "add" | "remove" | "deactivate" | "reactivate";
    reason?: string | null;
  }>;
  accessChanges?: Array<{
    action: "grant" | "revoke";
    member: string;
    container: string;
    reason?: string | null;
  }>;
  stageWhisper?: string | null;
  stageWhisperIds?: string[];
};

export type RuntimeEffectsPayload = {
  audienceChanges?: ManualTurnPayload["audienceChanges"];
  accessChanges?: ManualTurnPayload["accessChanges"];
};

export type StageWhisperCommand = {
  ownerScope: string;
  simulationId: string;
  branchId: string;
  expectedHead: string;
  commandId: string;
  targetActorId: string;
  text: string;
};

export type CreateContentRevisionInput = {
  ownerScope: string;
  compiled: CompiledWorkspace;
};

export type CreateSimulationInput = {
  ownerScope: string;
  simulationId: string;
  scenarioId: string | null;
  contentRevisionId: string;
  defaultBranchId: string;
  rootCommitId: string;
  commandId: string;
  sourceRoot: string;
};

export type StartSimulationInput = Omit<
  CreateSimulationInput,
  "contentRevisionId"
> & {
  compiled: CompiledWorkspace;
};

export type AppendCommitInput = {
  branchId: string;
  expectedHead: string;
  commandInput: RecordedCommand;
  commandFingerprint: string;
  commit: CommitRecord;
};

type MutationIdentity = {
  ownerScope: string;
  simulationId: string;
  commandId: string;
};

type BranchMutation = MutationIdentity & {
  branchId: string;
  expectedHead: string;
};

export type RecordedCommand =
  | ({ kind: "start" } & (CreateSimulationInput | StartSimulationInput))
  | ({ kind: "turn"; payload: ManualTurnPayload } & BranchMutation)
  | ({ kind: "effects"; payload: RuntimeEffectsPayload } & BranchMutation)
  | ({ kind: "closure"; payload: { label?: string | null } } & BranchMutation)
  | ({
      kind: "edit" | "regenerate";
      sourceBranchId: string;
      sourceCommitId: string;
      branchId: string;
      branchName?: string;
      expectedHead: string;
      payload: ManualTurnPayload;
    } & MutationIdentity)
  | ({
      kind: "fork";
      sourceBranchId: string;
      expectedHead: string;
      atCommitId: string;
      branchId: string;
      name?: string | null;
    } & MutationIdentity)
  | ({ kind: "whisper" } & StageWhisperCommand);

export type RecordedOutcome =
  | {
      kind: "start";
      simulation: SimulationRecord;
      branch: BranchRecord;
      root: CommitRecord;
      contentRevision?: ContentRevisionRecord;
    }
  | { kind: "commit"; branch: BranchRecord; commit: CommitRecord }
  | { kind: "branch"; branch: BranchRecord }
  | { kind: "whisper"; whisper: StageWhisperRecord };

export type SimulationArchive = {
  schemaVersion: 4;
  contentRevision: ContentRevisionRecord;
  simulation: SimulationRecord;
  branches: BranchRecord[];
  commits: CommitRecord[];
  stageWhispers: StageWhisperRecord[];
  commandResults: Array<{
    commandId: string;
    canonicalInput: RecordedCommand;
    fingerprint: string;
    result: RecordedOutcome;
    createdAt: string;
  }>;
};

export interface SimulationRepository {
  createContentRevision(
    input: CreateContentRevisionInput,
  ): ContentRevisionRecord;
  getContentRevision(
    ownerScope: string,
    revisionId: string,
  ): ContentRevisionRecord | null;
  createSimulation(input: CreateSimulationInput): {
    simulation: SimulationRecord;
    branch: BranchRecord;
    root: CommitRecord;
  };
  startSimulation(input: StartSimulationInput): {
    simulation: SimulationRecord;
    branch: BranchRecord;
    root: CommitRecord;
    contentRevision: ContentRevisionRecord;
  };
  getSimulation(
    ownerScope: string,
    simulationId: string,
  ): SimulationRecord | null;
  getBranch(
    ownerScope: string,
    simulationId: string,
    branchId: string,
  ): BranchRecord | null;
  getCommit(
    ownerScope: string,
    simulationId: string,
    commitId: string,
  ): CommitRecord | null;
  listAncestors(
    ownerScope: string,
    simulationId: string,
    headCommitId: string,
  ): CommitRecord[];
  appendCommit(input: AppendCommitInput): {
    branch: BranchRecord;
    commit: CommitRecord;
    replayed: boolean;
  };
  createBranch(input: {
    ownerScope: string;
    simulationId: string;
    sourceBranchId: string;
    expectedHead: string;
    branchId: string;
    name?: string | null;
    atCommitId: string;
    commandId: string;
  }): { branch: BranchRecord; replayed: boolean };
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
  }): { branch: BranchRecord; commit: CommitRecord; replayed: boolean };
  exportSimulation(ownerScope: string, simulationId: string): SimulationArchive;
  importSimulation(archive: SimulationArchive): void;
  createStageWhisper(input: StageWhisperCommand): StageWhisperRecord;
  listPendingStageWhispers(
    ownerScope: string,
    simulationId: string,
    branchId: string,
    expectedHead: string,
    targetActorId: string,
  ): StageWhisperRecord[];
  replayCommand(
    ownerScope: string,
    simulationId: string,
    commandId: string,
    fingerprint: string,
  ): RecordedOutcome | null;
}

export class BranchConflictError extends Error {
  readonly expectedHead: string;
  readonly actualHead: string;
  constructor(expectedHead: string, actualHead: string) {
    super(
      `Branch head conflict: expected ${expectedHead}, actual ${actualHead}.`,
    );
    this.name = "BranchConflictError";
    this.expectedHead = expectedHead;
    this.actualHead = actualHead;
  }
}

export class CommandIdentityError extends Error {
  constructor(commandId: string) {
    super(
      `Command identity ${commandId} was already used with different input.`,
    );
    this.name = "CommandIdentityError";
  }
}

export class DomainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainValidationError";
  }
}

export class DomainNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainNotFoundError";
  }
}
