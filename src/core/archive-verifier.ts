import { createHash } from "node:crypto";
import {
  applyValidatedAccessChange,
  assertValidAccessGraph,
} from "./access-graph.ts";
import {
  buildAccessEvents,
  buildAudienceEvents,
  buildManualMessage,
  buildStageWhisperEvents,
  canHoldEpisodeMemory,
  deriveFirstImpressionEvents,
  domainId,
  normalizeAudience,
  resolveTurnActor,
  stableStringify,
  unwrapRecordedOutcome,
} from "./domain-rules.ts";
import { deriveRetainedBeliefs } from "./retained-beliefs.ts";
import { legacyClosureOperations, projectPerceptions } from "./memory-operations.ts";
import { decodeAcceptDraftReceipt } from "./draft-contracts.ts";
import {
  assertRecordedCommandOutcome,
  assertRecordedOutcomeIdentity,
  decodeRecordedCommand,
  decodeRecordedOutcome,
  decodeContentRevisionRecord,
} from "./recorded-codec.ts";
import type { SimulationArchive } from "./ports.ts";
import type {
  CommitRecord,
  AcceptDraftReceipt,
  MemoryOperation,
  RuntimeEvent,
} from "./types.ts";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

export function validateSimulationArchive(archive: SimulationArchive): void {
  if (![4, 5, 6].includes(archive.schemaVersion))
    throw new Error(
      `Unsupported simulation archive schema: ${String(archive.schemaVersion)}`,
    );
  if (archive.schemaVersion !== 6) validateLegacyArchive(archive);
  if (archive.schemaVersion === 4) {
    const untouched = structuredClone(archive);
    untouched.schemaVersion = 5;
    untouched.memoryJobs = [];
    untouched.memoryJobTransitions = [];
    untouched.detachedMemoryOperations = [];
    validateSimulationArchive(untouched);
    upconvertV4Archive(archive);
  }
  if (archive.schemaVersion !== 5 && archive.schemaVersion !== 6)
    throw new Error(
      `Unsupported simulation archive schema: ${String(archive.schemaVersion)}`,
    );
  decodeContentRevisionRecord(archive.contentRevision);
  const { simulation, contentRevision } = archive;
  if (
    contentRevision.ownerScope !== simulation.ownerScope ||
    contentRevision.id !== simulation.contentRevisionId
  )
    throw new Error(
      "Simulation archive content scope or revision does not match its simulation.",
    );
  const digest = hash(
    stableStringify({ ...contentRevision.compiled, sourceRoot: "" }),
  );
  if (digest !== contentRevision.digest)
    throw new Error("Simulation archive content digest is invalid.");
  const ids = new Set(archive.commits.map((item) => item.id));
  if (ids.size !== archive.commits.length)
    throw new Error("Simulation archive contains duplicate commit IDs.");
  for (const commit of archive.commits) {
    validateCommitRecord(commit);
    if (
      commit.ownerScope !== simulation.ownerScope ||
      commit.simulationId !== simulation.id
    )
      throw new Error(
        "Simulation archive commit scope does not match its simulation.",
      );
    if (commit.parentCommitId && !ids.has(commit.parentCommitId))
      throw new Error(
        `Simulation archive commit parent is missing: ${commit.parentCommitId}`,
      );
    for (const event of commit.events) validateRuntimeEvent(event);
  }
  const operationIds = archive.commits.flatMap((commit) => commit.events.flatMap(
    (event) => event.type === "memory_operation" ? [event.operation.id]
      : event.type === "episode_closed" ? (event.closure.memoryOperations || []).map((item) => item.id)
      : [],
  ));
  if (new Set(operationIds).size !== operationIds.length)
    throw new Error("Simulation archive contains duplicate memory operation IDs.");
  validateMemoryJobs(archive);
  for (const branch of archive.branches) {
    validateBranchRecord(branch);
    if (
      branch.ownerScope !== simulation.ownerScope ||
      branch.simulationId !== simulation.id ||
      !ids.has(branch.headCommitId)
    )
      throw new Error(`Simulation archive branch is invalid: ${branch.id}`);
  }
  const branchIds = new Set(archive.branches.map((branch) => branch.id));
  if (branchIds.size !== archive.branches.length)
    throw new Error("Simulation archive contains duplicate branch IDs.");
  assertAcyclicBranchOrigins(archive);
  const commandIds = new Set(
    archive.commandResults.map((command) => command.commandId),
  );
  const whisperIds = new Set<string>();
  for (const whisper of archive.stageWhispers) {
    if (whisperIds.has(whisper.id))
      throw new Error(`Simulation archive contains duplicate whisper ID: ${whisper.id}`);
    whisperIds.add(whisper.id);
    const branch = archive.branches.find((item) => item.id === whisper.branchId);
    if (
      whisper.ownerScope !== simulation.ownerScope ||
      whisper.simulationId !== simulation.id ||
      !branchIds.has(whisper.branchId) ||
      !ids.has(whisper.expectedHead) ||
      !commandIds.has(whisper.commandId) ||
      !branch ||
      !isAncestor(archive.commits, whisper.expectedHead, branch.headCommitId)
    ) {
      throw new Error(
        `Simulation archive stage whisper is invalid: ${whisper.id}`,
      );
    }
  }
  validateCommandResults(archive);
  validateCanonicalProvenance(archive);
  replayAccessGraph(archive, topologicalCommits(archive.commits));
}


function validateLegacyArchive(archive: SimulationArchive): void {
  if (
    archive.commandResults.some(
      (command) => command.canonicalInput.kind === "accept_draft",
    ) ||
    archive.commits.some((commit) =>
      commit.events.some(
        (event) =>
          event.type === "message_accepted" &&
          event.message.provenance.mode === "generated",
      ),
    )
  ) throw new Error("Legacy simulation archives cannot contain draft acceptance artifacts.");
}

function upconvertV4Archive(archive: SimulationArchive): void {
  const jobs = [], transitions = [], detached: MemoryOperation[] = [];
  for (const commit of archive.commits) {
    const event = commit.events.find((item) => item.type === "episode_closed");
    if (!event || event.type !== "episode_closed") continue;
    const result = structuredClone(event.closure);
    result.memoryOperations ||= legacyClosureOperations(commit);
    const operations = result.memoryOperations;
    detached.push(...operations);
    const closureCommand = archive.commandResults.find(
      (item) => item.commandId === commit.commandId,
    );
    const originBranchId = closureCommand?.canonicalInput.kind === "closure"
      ? closureCommand.canonicalInput.branchId
      : null;
    const branch = archive.branches.find((item) => item.id === originBranchId);
    if (!branch || !commit.parentCommitId) throw new Error(`Invalid v4 closure ancestry: ${commit.id}`);
    const resultFingerprint = hash(stableStringify(result));
    const jobId = domainId("memory_job", archive.simulation.ownerScope, archive.simulation.id, commit.commandId);
    jobs.push({ id: jobId,
      ownerScope: archive.simulation.ownerScope, simulationId: archive.simulation.id,
      originBranchId: branch.id, episodeId: event.closure.episode.id, closureCommitId: commit.id,
      basisHeadCommitId: commit.parentCommitId, commandId: commit.commandId,
      label: event.closure.episode.label, status: "completed" as const, attemptCount: 1,
      resultFingerprint, result, lastError: null, createdAt: commit.createdAt,
      updatedAt: commit.createdAt });
    transitions.push(
      { id: domainId("memory_job_transition", jobId, "1", "running"),
        jobId, ownerScope: archive.simulation.ownerScope,
        simulationId: archive.simulation.id, attempt: 1, status: "running" as const,
        resultFingerprint: null, result: null, error: null, createdAt: commit.createdAt },
      { id: domainId("memory_job_transition", jobId, "1", "completed"),
        jobId, ownerScope: archive.simulation.ownerScope,
        simulationId: archive.simulation.id, attempt: 1, status: "completed" as const,
        resultFingerprint, result, error: null, createdAt: commit.createdAt },
    );
    event.closure.memories = [];
    event.closure.longTermMemories = [];
    event.closure.extractedBeliefs = [];
    event.closure.retainedBeliefs = [];
    event.closure.memoryOperations = [];
    const command = archive.commandResults.find((item) => item.commandId === commit.commandId);
    if (command?.result.kind === "commit")
      command.result.commit = structuredClone(commit);
  }
  archive.schemaVersion = 5; archive.memoryJobs = jobs;
  archive.memoryJobTransitions = transitions;
  archive.detachedMemoryOperations = detached;
}

function validateMemoryJobs(archive: SimulationArchive): void {
  const jobs = archive.memoryJobs;
  const transitions = archive.memoryJobTransitions;
  const operations = archive.detachedMemoryOperations;
  if (!jobs || !transitions || !operations)
    throw new Error("Simulation archive v5 memory job collections are missing.");
  const ids = new Set<string>(), transitionIds = new Set<string>();
  const operationIds = new Set<string>();
  for (const transition of transitions) {
    if (transitionIds.has(transition.id))
      throw new Error("Simulation archive contains duplicate memory job transition IDs.");
    transitionIds.add(transition.id);
    if (typeof transition.id !== "string" || typeof transition.jobId !== "string" ||
      typeof transition.ownerScope !== "string" || typeof transition.simulationId !== "string" ||
      !Number.isInteger(transition.attempt) || transition.attempt < 1 ||
      !["running", "failed", "completed"].includes(transition.status) ||
      typeof transition.createdAt !== "string")
      throw new Error("Simulation archive contains a malformed memory job transition.");
  }
  for (const operation of operations) {
    validateMemoryOperation(operation);
    if (operation.type !== "asserted" && operation.type !== "consolidated")
      throw new Error(`Simulation archive detached memory operation type is invalid: ${operation.id}`);
    if (operationIds.has(operation.id)) throw new Error("Simulation archive contains duplicate detached memory operation IDs.");
    operationIds.add(operation.id);
  }
  for (const job of jobs) {
    if (
      typeof job.id !== "string" || typeof job.ownerScope !== "string" ||
      typeof job.simulationId !== "string" || typeof job.originBranchId !== "string" ||
      typeof job.episodeId !== "string" || typeof job.closureCommitId !== "string" ||
      typeof job.basisHeadCommitId !== "string" || typeof job.commandId !== "string" ||
      typeof job.createdAt !== "string" || typeof job.updatedAt !== "string" ||
      !(job.label === null || typeof job.label === "string") ||
      !(job.resultFingerprint === null || typeof job.resultFingerprint === "string") ||
      !(job.result === null || typeof job.result === "object") ||
      !(job.lastError === null || typeof job.lastError === "string")
    ) throw new Error("Simulation archive contains a malformed memory job.");
    if (ids.has(job.id)) throw new Error("Simulation archive contains duplicate memory job IDs.");
    ids.add(job.id);
    const closure = archive.commits.find((item) => item.id === job.closureCommitId);
    const branch = archive.branches.find((item) => item.id === job.originBranchId);
    const command = archive.commandResults.find((item) => item.commandId === job.commandId);
    const closureInput = command?.canonicalInput.kind === "closure"
      ? command.canonicalInput : null;
    const detachedResult = operations.filter((item) => item.closureCommitId === job.closureCommitId);
    if (!closure || closure.kind !== "episode_closure" || closure.parentCommitId !== job.basisHeadCommitId ||
      closure.commandId !== job.commandId || !branch || !isAncestor(archive.commits, closure.id, branch.headCommitId) ||
      job.ownerScope !== archive.simulation.ownerScope || job.simulationId !== archive.simulation.id ||
      job.id !== domainId("memory_job", job.ownerScope, job.simulationId, job.commandId) ||
      job.episodeId !== domainId("episode", job.commandId) ||
      !["pending", "running", "failed", "completed"].includes(job.status) ||
      !Number.isInteger(job.attemptCount) || job.attemptCount < 0)
      throw new Error(`Simulation archive memory job is invalid: ${job.id}`);
    const normalizedLabel = closureInput?.payload.label?.trim() || null;
    const checkpoint = closure.events.find((item) => item.type === "episode_closed");
    if (!closureInput || closureInput.branchId !== job.originBranchId ||
      closureInput.expectedHead !== job.basisHeadCommitId ||
      normalizedLabel !== job.label || checkpoint?.type !== "episode_closed" ||
      checkpoint.closure.episode.label !== job.label ||
      checkpoint.closure.episode.closedAt !== job.createdAt ||
      closure.createdAt !== job.createdAt)
      throw new Error(`Simulation archive memory job request is not bound: ${job.id}`);
    validateJobTransitions(archive, job, transitions.filter((item) => item.jobId === job.id));
    if (job.status === "completed") {
      if (!job.result) throw new Error(`Simulation archive completed memory job result is missing: ${job.id}`);
      validateClosure(job.result);
      if (job.attemptCount < 1 || !job.resultFingerprint || job.lastError !== null ||
        hash(stableStringify(job.result)) !== job.resultFingerprint ||
        stableStringify(job.result.memoryOperations || []) !== stableStringify(detachedResult))
        throw new Error(`Simulation archive completed memory job result is invalid: ${job.id}`);
      if (job.result.episode.id !== job.episodeId ||
        job.result.episode.commitId !== job.closureCommitId ||
        job.result.episode.label !== job.label)
        throw new Error(`Simulation archive completed memory job episode is invalid: ${job.id}`);
      validateClosureIntegrity(archive, job.commandId, closure, job.result, false);
      const basis = ancestryThrough(archive.commits, job.basisHeadCommitId);
      const lastClosure = basis.findLastIndex((item) => item.kind === "episode_closure");
      const openCommits = basis.slice(lastClosure + 1);
      const expectedActors = archive.contentRevision.compiled.entities
        .filter(canHoldEpisodeMemory)
        .filter((entity) => projectPerceptions(openCommits).some((item) => item.actorId === entity.id))
        .map((entity) => entity.id);
      const assertedActors = detachedResult.filter((item) => item.type === "asserted").map((item) => item.actorId);
      if (stableStringify(assertedActors) !== stableStringify(expectedActors))
        throw new Error(`Simulation archive completed memory job operation set is incomplete: ${job.id}`);
    } else if (detachedResult.length || job.result !== null || job.resultFingerprint !== null ||
      (job.status === "pending" && (job.attemptCount !== 0 || job.lastError !== null)) ||
      (job.status === "running" && (job.attemptCount < 1 || job.lastError !== null)) ||
      (job.status === "failed" && (job.attemptCount < 1 || !job.lastError)))
      throw new Error(`Simulation archive incomplete memory job has a result: ${job.id}`);
    const perceptions = new Map(projectPerceptions(ancestryThrough(archive.commits, job.basisHeadCommitId)).map((item) => [item.id, item]));
    for (const operation of detachedResult) {
      if (operation.basisCommitId !== job.basisHeadCommitId ||
        operation.producer.mode !== "episode_closure" ||
        operation.producer.commandId !== job.commandId ||
        operation.type === "asserted" && operation.memoryKind !== "episode" ||
        operation.type === "consolidated" && operation.memoryKind !== "long_term" ||
        !("content" in operation) || !operation.content.trim())
        throw new Error(`Simulation archive detached memory operation basis is invalid: ${operation.id}`);
      validateMemoryOperationBasis(archive, closure, operation, perceptions);
      const expectedSources = projectPerceptions(
        ancestryThrough(archive.commits, job.basisHeadCommitId).slice(
          ancestryThrough(archive.commits, job.basisHeadCommitId)
            .findLastIndex((item) => item.kind === "episode_closure") + 1,
        ),
      ).filter((item) => item.actorId === operation.actorId);
      if (
        stableStringify(operation.sourcePerceptionIds) !== stableStringify(expectedSources.map((item) => item.id)) ||
        stableStringify(operation.sourceEventIds) !== stableStringify(expectedSources.map((item) => item.sourceEventId)) ||
        stableStringify(operation.sourceMessageVersionIds) !== stableStringify(expectedSources.map((item) => item.sourceMessageVersionId))
      ) throw new Error(`Simulation archive detached memory provenance is incomplete: ${operation.id}`);
      const expectedId = domainId("memory_operation", job.closureCommitId, operation.memoryId, operation.type);
      const expectedMemoryId = domainId(
        operation.type === "asserted" ? "episode_memory" : "long_memory",
        job.commandId, operation.actorId,
      );
      if (operation.id !== expectedId || operation.memoryId !== expectedMemoryId)
        throw new Error(`Simulation archive detached memory operation ID is invalid: ${operation.id}`);
      if (operation.type === "consolidated" && !detachedResult.some((item) =>
        item.type === "asserted" && item.memoryId === operation.episodeMemoryId &&
        item.actorId === operation.actorId))
        throw new Error(`Simulation archive consolidation has no episode assertion: ${operation.id}`);
    }
    const consolidations = detachedResult.filter((item) => item.type === "consolidated");
    if (new Set(consolidations.map((item) => item.actorId)).size !== consolidations.length)
      throw new Error(`Simulation archive contains duplicate consolidations: ${job.id}`);
  }
  for (const transition of transitions)
    if (!jobs.some((job) => job.id === transition.jobId))
      throw new Error(`Simulation archive memory job transition is unowned: ${transition.id}`);
  for (const operation of operations)
    if (!jobs.some((job) => job.closureCommitId === operation.closureCommitId))
      throw new Error(`Simulation archive detached memory operation is unowned: ${operation.id}`);
}

function validateJobTransitions(
  archive: SimulationArchive,
  job: NonNullable<SimulationArchive["memoryJobs"]>[number],
  transitions: NonNullable<SimulationArchive["memoryJobTransitions"]>,
): void {
  let expectedAttempt = 1;
  for (let index = 0; index < transitions.length;) {
    const running = transitions[index++];
    if (!running || running.status !== "running" || running.attempt !== expectedAttempt)
      throw new Error(`Simulation archive memory job transition order is invalid: ${job.id}`);
    validateTransitionIdentity(archive, job, running);
    const terminal = transitions[index];
    if (!terminal) break;
    if (terminal.attempt !== expectedAttempt ||
      !["failed", "completed"].includes(terminal.status))
      throw new Error(`Simulation archive memory job terminal transition is invalid: ${job.id}`);
    validateTransitionIdentity(archive, job, terminal);
    index++;
    if (terminal.status === "completed" && index !== transitions.length)
      throw new Error(`Simulation archive memory job has transitions after completion: ${job.id}`);
    expectedAttempt++;
  }
  const latest = transitions.at(-1);
  const expected = latest ? {
    status: latest.status, attemptCount: latest.attempt,
    resultFingerprint: latest.resultFingerprint, result: latest.result,
    lastError: latest.error, updatedAt: latest.createdAt,
  } : {
    status: "pending", attemptCount: 0, resultFingerprint: null,
    result: null, lastError: null, updatedAt: job.createdAt,
  };
  for (const key of Object.keys(expected) as Array<keyof typeof expected>)
    if (stableStringify(job[key]) !== stableStringify(expected[key]))
      throw new Error(`Simulation archive memory job current state is forged: ${job.id}`);
}

function validateTransitionIdentity(
  archive: SimulationArchive,
  job: NonNullable<SimulationArchive["memoryJobs"]>[number],
  transition: NonNullable<SimulationArchive["memoryJobTransitions"]>[number],
): void {
  if (transition.id !== domainId("memory_job_transition", job.id,
    String(transition.attempt), transition.status) ||
    transition.ownerScope !== archive.simulation.ownerScope ||
    transition.simulationId !== archive.simulation.id ||
    transition.status === "completed" && (!transition.result ||
      !transition.resultFingerprint || transition.error !== null) ||
    transition.status !== "completed" && (transition.result !== null ||
      transition.resultFingerprint !== null) ||
    transition.status === "failed" && (!transition.error ||
      transition.error.length > 256 || /(?:bearer|api[_-]?key|token|sk-)/i.test(transition.error)) ||
    transition.status === "running" && transition.error !== null)
    throw new Error(`Simulation archive memory job transition is invalid: ${transition.id}`);
}

function assertAcyclicBranchOrigins(archive: SimulationArchive): void {
  const branches = new Map(archive.branches.map((branch) => [branch.id, branch]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (branchId: string): void => {
    if (visited.has(branchId)) return;
    if (visiting.has(branchId))
      throw new Error(`Simulation archive branch-origin cycle at ${branchId}.`);
    const branch = branches.get(branchId);
    if (!branch) throw new Error(`Simulation archive branch is missing: ${branchId}.`);
    visiting.add(branchId);
    if (branch.origin.kind !== "root") visit(branch.origin.sourceBranchId);
    visiting.delete(branchId);
    visited.add(branchId);
  };
  for (const branchId of branches.keys()) visit(branchId);
}

function replayAccessGraph(
  archive: SimulationArchive,
  commits: CommitRecord[],
): void {
  assertValidAccessGraph(archive.contentRevision.compiled.accessLinks);
  const byCommit = new Map<string, typeof archive.contentRevision.compiled.accessLinks>();
  for (const commit of commits) {
    let links = commit.parentCommitId
      ? [...(byCommit.get(commit.parentCommitId) || [])]
      : [...archive.contentRevision.compiled.accessLinks];
    for (const event of commit.events)
      if (event.type === "access_changed")
        links = applyValidatedAccessChange(links, event);
    byCommit.set(commit.id, links);
  }
}

function validateCanonicalProvenance(archive: SimulationArchive): void {
  const commands = new Map(
    archive.commandResults.map((command) => [command.commandId, command]),
  );
  const roots = archive.commits.filter((commit) => commit.kind === "root");
  const rootOrigins = archive.branches.filter(
    (branch) => branch.origin.kind === "root",
  );
  const rootBranch = archive.branches.find(
    (branch) => branch.id === archive.simulation.defaultBranchId,
  );
  if (
    roots.length !== 1 ||
    rootOrigins.length !== 1 ||
    rootOrigins[0]?.id !== archive.simulation.defaultBranchId ||
    !rootBranch
  )
    throw new Error("Simulation archive must contain exactly one root.");
  const root = roots[0]!;
  if (
    root.events.length !== 0 ||
    rootBranch.origin.kind !== "root" ||
    rootBranch.origin.commandId !== root.commandId ||
    rootBranch.origin.baseCommitId !== root.id
  )
    throw new Error("Simulation archive root branch origin is invalid.");
  for (const commit of archive.commits) {
    const command = commands.get(commit.commandId);
    if (!command || !isRecord(command.result))
      throw new Error(`Simulation archive commit lacks command provenance: ${commit.id}`);
    const resultCommit = command.result.kind === "commit"
      ? command.result.commit
      : null;
    const resultRoot = command.result.kind === "start"
      ? command.result.root
      : null;
    const backed = commit.kind === "root"
      ? isRecord(resultRoot) && resultRoot.id === commit.id
      : isRecord(resultCommit) && resultCommit.id === commit.id;
    if (!backed)
      throw new Error(`Simulation archive commit provenance is invalid: ${commit.id}`);
    if (!archive.branches.some(
      (branch) => isAncestor(archive.commits, commit.id, branch.headCommitId),
    ))
      throw new Error(`Simulation archive commit is not owned by a branch: ${commit.id}`);
  }
  for (const branch of archive.branches) {
    const command = commands.get(branch.origin.commandId);
    if (
      !command ||
      command.result.kind === "whisper" ||
      !isRecord(command.result.branch)
    )
      throw new Error(`Simulation archive branch lacks command provenance: ${branch.id}`);
    if (command.result.branch.id !== branch.id)
      throw new Error(`Simulation archive branch provenance is invalid: ${branch.id}`);
    validateBranchOriginCommand(archive, branch, command);
    if (branch.origin.kind !== "root") validateNonRootBranchOrigin(archive, branch);
  }
  for (const whisper of archive.stageWhispers) {
    const command = commands.get(whisper.commandId);
    if (
      !command ||
      command.result.kind !== "whisper" ||
      command.result.whisper.id !== whisper.id
    )
      throw new Error(`Simulation archive whisper lacks command provenance: ${whisper.id}`);
  }
}

function validateBranchOriginCommand(
  archive: SimulationArchive,
  branch: SimulationArchive["branches"][number],
  command: SimulationArchive["commandResults"][number],
): void {
  const origin = branch.origin;
  const input = command.canonicalInput;
  const invalid = (): never => {
    throw new Error(`Simulation archive branch provenance is invalid: ${branch.id}`);
  };
  if (!isRecord(input)) invalid();
  if (origin.kind === "root") {
    if (
      branch.id !== archive.simulation.defaultBranchId ||
      input.kind !== "start" ||
      command.result.kind !== "start"
    ) invalid();
    return;
  }
  if (branch.id === archive.simulation.defaultBranchId) invalid();
  if (origin.kind === "fork") {
    if (
      input.kind !== "fork" ||
      input.branchId !== branch.id ||
      input.sourceBranchId !== origin.sourceBranchId ||
      input.expectedHead !== origin.sourceHeadCommitId ||
      input.atCommitId !== origin.baseCommitId ||
      command.result.kind !== "branch"
    ) invalid();
    return;
  }
  if (origin.kind === "edit") {
    if (
      input.kind !== "edit" ||
      input.branchId !== branch.id ||
      input.sourceBranchId !== origin.sourceBranchId ||
      input.expectedHead !== origin.sourceHeadCommitId ||
      command.result.kind !== "commit" ||
      command.result.commit.parentCommitId !== origin.baseCommitId
    ) invalid();
    return;
  }
  if (
    input.kind !== "regenerate" ||
    input.branchId !== branch.id ||
    input.sourceBranchId !== origin.sourceBranchId ||
    input.expectedHead !== origin.sourceHeadCommitId ||
    command.result.kind !== "commit" ||
    command.result.commit.parentCommitId !== origin.baseCommitId
  ) invalid();
}

function validateNonRootBranchOrigin(
  archive: SimulationArchive,
  branch: SimulationArchive["branches"][number],
): void {
  const origin = branch.origin;
  if (origin.kind === "root") return;
  const source = archive.branches.find((item) => item.id === origin.sourceBranchId);
  if (
    !source ||
    origin.sourceBranchId === branch.id ||
    !isAncestor(archive.commits, origin.baseCommitId, origin.sourceHeadCommitId) ||
    !isAncestor(archive.commits, origin.sourceHeadCommitId, source.headCommitId) ||
    !isAncestor(archive.commits, origin.baseCommitId, branch.headCommitId)
  )
    throw new Error(`Simulation archive branch origin is invalid: ${branch.id}`);
}

function validateCommandResults(archive: SimulationArchive): void {
  const commands = new Set<string>();
  for (const command of archive.commandResults) {
    if (commands.has(command.commandId))
      throw new Error(
        `Simulation archive contains duplicate command result: ${command.commandId}`,
      );
    commands.add(command.commandId);
    let canonicalInput;
    let result;
    try {
      canonicalInput = decodeRecordedCommand(command.canonicalInput);
    } catch {
      throw invalidCommandResult(command.commandId, "input structure mismatch");
    }
    try {
      result = decodeRecordedOutcome(command.result);
      assertRecordedCommandOutcome(canonicalInput, result);
      assertRecordedOutcomeIdentity(canonicalInput, result);
    } catch {
      throw invalidCommandResult(command.commandId, "outcome structure mismatch");
    }
    const decoded = { ...command, canonicalInput, result };
    if (
      typeof command.fingerprint !== "string" ||
      command.fingerprint !== hash(stableStringify(decoded.canonicalInput))
    )
      throw invalidCommandResult(command.commandId, "fingerprint mismatch");
    validateCanonicalCommandInput(archive, decoded);
    validateCommandResult(archive, command.commandId, decoded.result);
  }
}

function validateCanonicalCommandInput(
  archive: SimulationArchive,
  command: SimulationArchive["commandResults"][number],
): void {
  const input = command.canonicalInput;
  if (!isRecord(input))
    throw invalidCommandResult(command.commandId, "input is not an object");
  if (
    ![
      "start", "turn", "effects", "closure", "edit", "regenerate", "fork",
      "whisper", "accept_draft", "revise_memory", "retract_memory",
    ].includes(String(input.kind)) ||
    input.ownerScope !== archive.simulation.ownerScope ||
    input.simulationId !== archive.simulation.id ||
    input.commandId !== command.commandId
  )
    throw invalidCommandResult(command.commandId, "input identity mismatch");
  if (!isRecord(command.result))
    throw invalidCommandResult(command.commandId, "result is not an object");
  const expectedOutcomeKind = input.kind === "start"
    ? "start"
    : input.kind === "fork"
      ? "branch"
      : input.kind === "whisper"
        ? "whisper"
        : "commit";
  if (command.result.kind !== expectedOutcomeKind)
    throw invalidCommandResult(command.commandId, "command outcome kind mismatch");
  const decodedInput = withoutKind(input);
  const result = unwrapRecordedOutcome(command.result) as Record<string, unknown>;
  if (input.kind === "start")
    validateStartInput(archive, command, decodedInput, result);
  else if (input.kind === "accept_draft")
    validateAcceptedDraftCommandShape(archive, command, decodedInput, result);
  else if (["turn", "effects", "closure", "edit", "regenerate", "revise_memory", "retract_memory"].includes(
    String(input.kind),
  ))
    validateCommitInput(archive, command, decodedInput, result);
  else if (input.kind === "fork")
    validateForkInput(archive, command, decodedInput, result);
  else validateWhisperInput(archive, command, decodedInput, result);
}

function withoutKind(input: Record<string, unknown>): Record<string, unknown> {
  const { kind: _, ...value } = input;
  return value;
}

function validateStartInput(
  archive: SimulationArchive,
  command: SimulationArchive["commandResults"][number],
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): void {
  const compiledShape = Object.hasOwn(input, "compiled");
  assertExactInput(
    command.commandId,
    input,
    compiledShape
      ? [
          "ownerScope", "simulationId", "scenarioId", "contentRevisionId",
          "defaultBranchId", "rootCommitId", "commandId", "sourceRoot",
          "compiled",
        ].filter((key) => key !== "contentRevisionId")
      : [
          "ownerScope", "simulationId", "scenarioId", "contentRevisionId",
          "defaultBranchId", "rootCommitId", "commandId", "sourceRoot",
        ],
  );
  if (!isRecord(result.root) || !isRecord(result.branch))
    throw invalidCommandResult(command.commandId, "invalid start result");
  const expectedRevision = compiledShape
    ? stableStringify(input.compiled) ===
      stableStringify(archive.contentRevision.compiled)
    : input.contentRevisionId === archive.contentRevision.id;
  if (
    input.scenarioId !== archive.simulation.scenarioId ||
    input.defaultBranchId !== archive.simulation.defaultBranchId ||
    input.defaultBranchId !== result.branch.id ||
    input.rootCommitId !== result.root.id ||
    input.sourceRoot !== archive.simulation.sourceRoot ||
    !expectedRevision
  )
    throw invalidCommandResult(command.commandId, "input start basis mismatch");
}

function validateCommitInput(
  archive: SimulationArchive,
  command: SimulationArchive["commandResults"][number],
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): void {
  if (!isRecord(result.commit) || !isRecord(result.branch))
    throw invalidCommandResult(command.commandId, "invalid commit result");
  const resultCommit = result.commit;
  const commit = archive.commits.find((item) => item.id === resultCommit.id);
  if (!commit)
    throw invalidCommandResult(command.commandId, "input commit missing");
  if (
    commit.id !== domainId(
      "commit",
      archive.simulation.ownerScope,
      archive.simulation.id,
      command.commandId,
    )
  )
    throw invalidCommandResult(command.commandId, "commit identity mismatch");
  const commandKind = command.canonicalInput.kind;
  if (
    (commit.kind === "turn" && !["turn", "edit", "regenerate"].includes(commandKind)) ||
    (commit.kind === "effects" && commandKind !== "effects") ||
    (commit.kind === "episode_closure" && commandKind !== "closure")
    || (commit.kind === "memory" && !["revise_memory", "retract_memory"].includes(commandKind))
  )
    throw invalidCommandResult(command.commandId, "command kind mismatch");
  if (commit.kind === "turn")
    validateTurnInput(
      archive,
      command.commandId,
      input,
      result,
      commit,
      commandKind as "turn" | "edit" | "regenerate",
    );
  else if (commit.kind === "effects")
    validateEffectsInput(archive, command.commandId, input, result, commit);
  else if (commit.kind === "episode_closure")
    validateClosureInput(archive, command.commandId, input, result, commit);
  else if (commit.kind === "memory")
    validateMemoryInput(archive, command.commandId, input, result, commit, commandKind);
  else throw invalidCommandResult(command.commandId, "unsupported commit input");
}

function validateTurnInput(
  archive: SimulationArchive,
  commandId: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
  commit: CommitRecord,
  commandKind: "turn" | "edit" | "regenerate",
): void {
  const sibling = Object.hasOwn(input, "sourceBranchId");
  assertExactInput(
    commandId,
    input,
    sibling
      ? [
          "ownerScope", "simulationId", "sourceBranchId", "sourceCommitId",
          "branchId", "branchName?", "expectedHead", "commandId", "payload",
        ]
      : [
          "ownerScope", "simulationId", "branchId", "expectedHead",
          "commandId", "payload",
        ],
  );
  if (!isRecord(input.payload) || !isRecord(result.branch))
    throw invalidCommandResult(commandId, "invalid turn input");
  assertExactInput(commandId, input.payload, [
    "actorId", "text", "audience",
    "audienceChanges?", "accessChanges?", "stageWhisper?",
    "stageWhisperIds?",
  ]);
  const messageEvents = commit.events.filter(
    (event) => event.type === "message_accepted",
  );
  if (messageEvents.length !== 1 || messageEvents[0]?.type !== "message_accepted")
    throw invalidCommandResult(commandId, "turn message mismatch");
  const message = messageEvents[0].message;
  const actorId = requiredInputString(commandId, input.payload, "actorId");
  const text = requiredInputString(commandId, input.payload, "text").trim();
  const requestedAudience = inputStringArray(
    commandId,
    input.payload.audience,
    "audience",
  );
  const audience = normalizeAudience(actorId, requestedAudience);
  requireArchiveActor(archive, commandId, actorId);
  for (const audienceActorId of audience)
    requireArchiveActor(archive, commandId, audienceActorId);
  const operation = sibling ? commandKind : "turn";
  if (
    input.payload.operation !== undefined &&
    !["turn", "edit", "regenerate"].includes(
      String(input.payload.operation),
    )
  )
    throw invalidCommandResult(commandId, "turn operation mismatch");
  if (
    input.payload.logicalMessageId !== undefined &&
    typeof input.payload.logicalMessageId !== "string"
  )
    throw invalidCommandResult(commandId, "logical message mismatch");
  const expectedMessage = buildManualMessage({
    ownerScope: archive.simulation.ownerScope,
    simulationId: archive.simulation.id,
    commandId,
    actorId,
    text,
    audience,
    logicalMessageId: sibling
      ? message.logicalMessageId
      : domainId(
        "message",
        archive.simulation.ownerScope,
        archive.simulation.id,
        commandId,
      ),
    operation: operation as "turn" | "edit" | "regenerate",
  });
  if (
    stableStringify(expectedMessage) !== stableStringify(message)
  )
    throw invalidCommandResult(commandId, "turn payload mismatch");
  if (
    !sibling &&
    message.logicalMessageId !== domainId(
      "message",
      archive.simulation.ownerScope,
      archive.simulation.id,
      commandId,
    )
  )
    throw invalidCommandResult(commandId, "logical message mismatch");
  validateTurnBasis(archive, commandId, input, result, commit, message, sibling);
  validateTurnEvents(archive, commandId, input, commit, message, actorId);
}

function validateTurnBasis(
  archive: SimulationArchive,
  commandId: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
  commit: CommitRecord,
  message: {
    actorId: string;
    logicalMessageId: string;
    provenance: { operation: string };
  },
  sibling: boolean,
): void {
  if (!isRecord(result.branch))
    throw invalidCommandResult(commandId, "turn branch mismatch");
  if (!sibling) {
    if (
      input.branchId !== result.branch.id ||
      input.expectedHead !== commit.parentCommitId
    )
      throw invalidCommandResult(commandId, "turn branch basis mismatch");
    return;
  }
  const source = archive.commits.find((item) => item.id === input.sourceCommitId);
  const sourceMessage = source?.events.find(
    (event) => event.type === "message_accepted",
  );
  const sourceBranch = archive.branches.find(
    (branch) => branch.id === input.sourceBranchId,
  );
  const defaultName = message.provenance.operation;
  const resultOrigin = isRecord(result.branch.origin)
    ? result.branch.origin
    : null;
  if (
    input.branchName !== undefined &&
    typeof input.branchName !== "string"
  )
    throw invalidCommandResult(commandId, "branch name mismatch");
  if (
    !source ||
    !sourceMessage ||
    sourceMessage.type !== "message_accepted" ||
    !sourceBranch ||
    input.branchId !== result.branch.id ||
    input.sourceBranchId === result.branch.id ||
    !resultOrigin ||
    resultOrigin.kind !== message.provenance.operation ||
    resultOrigin.commandId !== commandId ||
    resultOrigin.sourceBranchId !== input.sourceBranchId ||
    resultOrigin.sourceHeadCommitId !== input.expectedHead ||
    resultOrigin.baseCommitId !== commit.parentCommitId ||
    !isAncestor(archive.commits, source.id, String(input.expectedHead)) ||
    commit.parentCommitId !== source.parentCommitId ||
    message.logicalMessageId !== sourceMessage.message.logicalMessageId ||
    message.actorId !== sourceMessage.message.actorId ||
    result.branch.name !== (input.branchName || defaultName)
  )
    throw invalidCommandResult(commandId, "sibling turn basis mismatch");
}

function validateEffectsInput(
  archive: SimulationArchive,
  commandId: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
  commit: CommitRecord,
): void {
  assertExactInput(commandId, input, [
    "ownerScope", "simulationId", "branchId", "expectedHead", "commandId",
    "payload",
  ]);
  if (!isRecord(input.payload) || !isRecord(result.branch))
    throw invalidCommandResult(commandId, "invalid effects input");
  assertExactInput(commandId, input.payload, [
    "audienceChanges?", "accessChanges?",
  ]);
  if (
    input.branchId !== result.branch.id ||
    input.expectedHead !== commit.parentCommitId
  )
    throw invalidCommandResult(commandId, "effects branch mismatch");
  const expected = normalizedEffectEvents(commandId, input.payload);
  if (!expected.length)
    throw invalidCommandResult(commandId, "runtime effects command has no effects");
  validateEffectEntities(archive, commandId, expected);
  if (stableStringify(expected) !== stableStringify(commit.events))
    throw invalidCommandResult(commandId, "runtime effects mismatch");
}

function normalizedEffectEvents(
  commandId: string,
  payload: Record<string, unknown>,
): RuntimeEvent[] {
  return [
    ...buildAudienceEvents(normalizeAudienceChanges(commandId, payload.audienceChanges)),
    ...buildAccessEvents(normalizeAccessChanges(commandId, payload.accessChanges)),
  ];
}

function requireArchiveActor(
  archive: SimulationArchive,
  commandId: string,
  actorId: string,
): void {
  const entity = archive.contentRevision.compiled.entities.find(
    (item) => item.id === actorId,
  );
  if (!entity || !resolveTurnActor([entity], actorId))
    throw invalidCommandResult(commandId, `unknown actor ${actorId}`);
}

function validateTurnEvents(
  archive: SimulationArchive,
  commandId: string,
  input: Record<string, unknown>,
  commit: CommitRecord,
  message: Extract<RuntimeEvent, { type: "message_accepted" }>["message"],
  actorId: string,
): void {
  const payload = input.payload as Record<string, unknown>;
  const expected: RuntimeEvent[] = [{ type: "message_accepted", message }];
  expected.push(...normalizedEffectEvents(commandId, payload));
  validateEffectEntities(archive, commandId, expected);
  expected.push(...expectedFirstImpressionEvents(archive, commit, message.audience));
  expected.push(...expectedWhisperEvents(archive, commandId, input, commit, actorId));
  if (stableStringify(expected) !== stableStringify(commit.events))
    throw invalidCommandResult(commandId, "complete turn event sequence mismatch");
}

function validateEffectEntities(
  archive: SimulationArchive,
  commandId: string,
  events: RuntimeEvent[],
): void {
  const entities = new Set(
    archive.contentRevision.compiled.entities.map((entity) => entity.id),
  );
  for (const event of events) {
    if (event.type === "audience_changed")
      requireArchiveActor(archive, commandId, event.actorId);
    if (
      event.type === "access_changed" &&
      (!entities.has(event.member) || !entities.has(event.container))
    )
      throw invalidCommandResult(commandId, "access entity mismatch");
  }
}

function expectedFirstImpressionEvents(
  archive: SimulationArchive,
  commit: CommitRecord,
  audience: string[],
): RuntimeEvent[] {
  const existing: Array<{ observerId: string; entityId: string }> = [];
  for (const ancestor of ancestryThrough(archive.commits, commit.parentCommitId))
    for (const event of ancestor.events)
      if (event.type === "first_impression_formed")
        existing.push(event.impression);
  return deriveFirstImpressionEvents({
    audience,
    surfaces: archive.contentRevision.compiled.surfaces,
    existing,
  });
}

function normalizeAudienceChanges(commandId: string, value: unknown) {
  return inputRecordArray(commandId, value, "audienceChanges").map((item) => {
    assertExactInput(commandId, item, ["actorId", "action", "reason?"]);
    const action = requiredInputString(commandId, item, "action");
    if (!["add", "remove", "deactivate", "reactivate"].includes(action))
      throw invalidCommandResult(commandId, "audience action mismatch");
    return {
      actorId: requiredInputString(commandId, item, "actorId"),
      action: action as "add" | "remove" | "deactivate" | "reactivate",
      reason: nullableInputString(commandId, item.reason, "reason") || null,
    };
  });
}

function normalizeAccessChanges(commandId: string, value: unknown) {
  return inputRecordArray(commandId, value, "accessChanges").map((item) => {
    assertExactInput(commandId, item, [
      "action", "member", "container", "reason?",
    ]);
    const action = requiredInputString(commandId, item, "action");
    if (!["grant", "revoke"].includes(action))
      throw invalidCommandResult(commandId, "access action mismatch");
    return {
      action: action as "grant" | "revoke",
      member: requiredInputString(commandId, item, "member"),
      container: requiredInputString(commandId, item, "container"),
      reason: nullableInputString(commandId, item.reason, "reason") || null,
    };
  });
}

function expectedWhisperEvents(
  archive: SimulationArchive,
  commandId: string,
  input: Record<string, unknown>,
  commit: CommitRecord,
  actorId: string,
): RuntimeEvent[] {
  const payload = input.payload as Record<string, unknown>;
  const pending = archive.stageWhispers.filter(
    (whisper) =>
      whisper.branchId === (input.sourceBranchId || input.branchId) &&
      whisper.expectedHead === commit.parentCommitId &&
      whisper.targetActorId === actorId,
  );
  const requested = payload.stageWhisperIds === undefined
    ? pending.map((whisper) => whisper.id)
    : inputStringArray(
        commandId,
        payload.stageWhisperIds,
        "stageWhisperIds",
      );
  if (new Set(requested).size !== requested.length)
    throw invalidCommandResult(commandId, "selected whispers contain duplicates");
  const selected = requested.map((id) => {
    const whisper = pending.find((item) => item.id === id);
    if (!whisper)
      throw invalidCommandResult(commandId, "selected whisper mismatch");
    return whisper;
  });
  const inline = payload.stageWhisper === undefined || payload.stageWhisper === null
    ? null
    : nullableInputString(
      commandId,
      payload.stageWhisper,
      "stageWhisper",
    );
  return buildStageWhisperEvents({
    ownerScope: archive.simulation.ownerScope,
    simulationId: archive.simulation.id,
    commandId,
    actorId,
    selected,
    inline,
  });
}

function deterministicWhisperId(
  archive: SimulationArchive,
  commandId: string,
): string {
  return domainId(
    "whisper",
    archive.simulation.ownerScope,
    archive.simulation.id,
    commandId,
  );
}

function ancestryThrough(
  commits: CommitRecord[],
  headId: string | null,
): CommitRecord[] {
  if (!headId) return [];
  const byId = new Map(commits.map((commit) => [commit.id, commit]));
  const result: CommitRecord[] = [];
  let cursor: string | null = headId;
  while (cursor) {
    const commit = byId.get(cursor);
    if (!commit) break;
    result.push(commit);
    cursor = commit.parentCommitId;
  }
  return result.reverse();
}

function validateClosureInput(
  archive: SimulationArchive,
  commandId: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
  commit: CommitRecord,
): void {
  assertExactInput(commandId, input, [
    "ownerScope", "simulationId", "branchId", "expectedHead", "commandId",
    "payload",
  ]);
  if (!isRecord(input.payload) || !isRecord(result.branch))
    throw invalidCommandResult(commandId, "invalid closure input");
  assertExactInput(commandId, input.payload, ["label?"]);
  const event = commit.events.find((item) => item.type === "episode_closed");
  const label = nullableInputString(
    commandId,
    input.payload.label,
    "label",
  )?.trim() || null;
  if (
    commit.events.length !== 1 ||
    !event ||
    event.type !== "episode_closed" ||
    input.branchId !== result.branch.id ||
    input.expectedHead !== commit.parentCommitId ||
    label !== event.closure.episode.label
  )
    throw invalidCommandResult(commandId, "closure input mismatch");
  validateClosureIntegrity(archive, commandId, commit, event.closure);
}

function validateClosureIntegrity(
  archive: SimulationArchive,
  commandId: string,
  commit: CommitRecord,
  closure: Extract<RuntimeEvent, { type: "episode_closed" }>["closure"],
  allowCheckpoint = true,
): void {
  const episodeId = domainId("episode", commandId);
  if (
    commit.id !== domainId(
      "commit",
      archive.simulation.ownerScope,
      archive.simulation.id,
      commandId,
    ) ||
    closure.episode.id !== episodeId ||
    closure.episode.commitId !== commit.id ||
    closure.episode.simulationId !== archive.simulation.id
  )
    throw invalidCommandResult(commandId, "closure identity mismatch");
  const ancestry = ancestryThrough(archive.commits, commit.parentCommitId);
  const lastClosure = ancestry.findLastIndex((item) => item.kind === "episode_closure");
  const openTurns = ancestry.slice(lastClosure + 1).flatMap((item) =>
    item.events
      .filter((event) => event.type === "message_accepted")
      .map((event) => ({ commit: item, message: event.message })),
  );
  if (!openTurns.length)
    throw invalidCommandResult(commandId, "closure has no open turns");
  const detachedJob = archive.memoryJobs?.find(
    (job) => job.closureCommitId === commit.id,
  );
  if (detachedJob && allowCheckpoint) {
    if (
      detachedJob.episodeId !== closure.episode.id ||
      closure.memories.length || closure.longTermMemories.length ||
      closure.extractedBeliefs.length || closure.retainedBeliefs.length ||
      (closure.memoryOperations?.length || 0)
    ) throw invalidCommandResult(commandId, "closure checkpoint payload mismatch");
    return;
  }
  const entities = new Map(
    archive.contentRevision.compiled.entities.map((entity) => [entity.id, entity]),
  );
  const memories = new Map(closure.memories.map((memory) => [memory.id, memory]));
  const expectedMemoryActors = archive.contentRevision.compiled.entities
    .filter(canHoldEpisodeMemory)
    .filter((entity) => openTurns.some((turn) => turn.message.audience.includes(entity.id)))
    .map((entity) => entity.id);
  if (
    stableStringify(closure.memories.map((memory) => memory.actorId)) !==
    stableStringify(expectedMemoryActors)
  )
    throw invalidCommandResult(commandId, "episode memory actor set mismatch");
  const recordIds = new Set<string>();
  for (const memory of closure.memories) {
    const actor = entities.get(memory.actorId);
    const expectedSourceTurnIds = openTurns
      .filter((turn) => turn.message.audience.includes(memory.actorId))
      .map((turn) => turn.message.id);
    const expectedPerceptions = projectPerceptions(
      openTurns.map((turn) => turn.commit),
    ).filter((item) => item.actorId === memory.actorId);
    if (
      !actor || !canHoldEpisodeMemory(actor) ||
      !memory.text.trim() ||
      memory.id !== domainId("episode_memory", commandId, memory.actorId) ||
      memory.episodeId !== episodeId ||
      memory.simulationId !== archive.simulation.id ||
      new Set(memory.sourceTurnIds).size !== memory.sourceTurnIds.length ||
      stableStringify(memory.sourceTurnIds) !== stableStringify(expectedSourceTurnIds) ||
      closure.memoryOperations !== undefined && (
        memory.sourcePerceptionIds === undefined ||
        memory.sourceEventIds === undefined ||
        memory.sourceMessageVersionIds === undefined
      ) ||
      memory.sourcePerceptionIds !== undefined &&
        stableStringify(memory.sourcePerceptionIds) !==
          stableStringify(expectedPerceptions.map((item) => item.id)) ||
      memory.sourceEventIds !== undefined &&
        stableStringify(memory.sourceEventIds) !==
          stableStringify(expectedPerceptions.map((item) => item.sourceEventId)) ||
      memory.sourceMessageVersionIds !== undefined &&
        stableStringify(memory.sourceMessageVersionIds) !== stableStringify(
          expectedPerceptions.map((item) => item.sourceMessageVersionId),
        )
    )
      throw invalidCommandResult(commandId, "episode memory provenance mismatch");
    addUniqueClosureId(commandId, recordIds, memory.id);
  }
  for (const memory of closure.longTermMemories) {
    const source = memories.get(memory.episodeMemoryId);
    if (
      !source || source.actorId !== memory.actorId || !memory.text.trim() ||
      memory.id !== domainId("long_memory", commandId, memory.actorId) ||
      memory.episodeId !== episodeId ||
      memory.simulationId !== archive.simulation.id
    )
      throw invalidCommandResult(commandId, "long-term memory provenance mismatch");
    addUniqueClosureId(commandId, recordIds, memory.id);
  }
  const extractedIndexes = new Map<string, number>();
  for (const belief of closure.extractedBeliefs) {
    const memory = memories.get(belief.memoryId);
    const index = extractedIndexes.get(belief.holder) || 0;
    extractedIndexes.set(belief.holder, index + 1);
    if (
      !memory || memory.actorId !== belief.holder ||
      belief.id !== domainId("belief", commandId, belief.holder, String(index)) ||
      belief.episodeId !== episodeId ||
      belief.simulationId !== archive.simulation.id ||
      !isBeliefStrength(belief.strength)
    )
      throw invalidCommandResult(commandId, "extracted belief provenance mismatch");
    addUniqueClosureId(commandId, recordIds, belief.id);
  }
  const expectedRetained = deriveRetainedBeliefs({
    simulationId: archive.simulation.id,
    commandId,
    episodeId,
    createdAt: closure.episode.closedAt,
    entities: archive.contentRevision.compiled.entities,
    initialBeliefs: archive.contentRevision.compiled.beliefs,
    initialAccessLinks: archive.contentRevision.compiled.accessLinks,
    ancestry,
  });
  if (stableStringify(closure.retainedBeliefs) !== stableStringify(expectedRetained))
    throw invalidCommandResult(commandId, "retained belief set mismatch");
  for (const belief of closure.retainedBeliefs)
    addUniqueClosureId(commandId, recordIds, belief.id);
  if (closure.memoryOperations) {
    const allPerceptions = new Map(projectPerceptions(ancestry).map((item) => [item.id, item]));
    const expectedIds = new Set([
      ...closure.memories.map((memory) => memory.id),
      ...closure.longTermMemories.map((memory) => memory.id),
    ]);
    if (closure.memoryOperations.length !== expectedIds.size)
      throw invalidCommandResult(commandId, "closure memory operation set mismatch");
    for (const operation of closure.memoryOperations) {
      if (!expectedIds.has(operation.memoryId))
        throw invalidCommandResult(commandId, "closure memory operation target mismatch");
      validateMemoryOperationBasis(archive, commit, operation, allPerceptions);
      if (
        operation.basisCommitId !== commit.parentCommitId ||
        operation.closureCommitId !== commit.id ||
        operation.producer.mode !== "episode_closure" ||
        operation.producer.commandId !== commandId
      ) throw invalidCommandResult(commandId, "closure memory operation provenance mismatch");
      const episodeMemory = closure.memories.find((item) => item.id === operation.memoryId);
      const longMemory = closure.longTermMemories.find((item) => item.id === operation.memoryId);
      const sourceMemory = episodeMemory || (longMemory
        ? closure.memories.find((item) => item.id === longMemory.episodeMemoryId)
        : null);
      if (
        !sourceMemory ||
        stableStringify(operation.sourcePerceptionIds) !==
          stableStringify(sourceMemory.sourcePerceptionIds) ||
        stableStringify(operation.sourceEventIds) !==
          stableStringify(sourceMemory.sourceEventIds) ||
        stableStringify(operation.sourceMessageVersionIds) !==
          stableStringify(sourceMemory.sourceMessageVersionIds)
      ) throw invalidCommandResult(commandId, "memory operation source set mismatch");
      if (episodeMemory) {
        if (
          operation.type !== "asserted" || operation.memoryKind !== "episode" ||
          operation.content !== episodeMemory.text ||
          operation.id !== domainId("memory_operation", commit.id, episodeMemory.id, "asserted")
        ) throw invalidCommandResult(commandId, "episode assertion mismatch");
      } else if (
        !longMemory || operation.type !== "consolidated" ||
        operation.memoryKind !== "long_term" || operation.content !== longMemory.text ||
        operation.episodeMemoryId !== longMemory.episodeMemoryId ||
        operation.id !== domainId("memory_operation", commit.id, longMemory.id, "consolidated")
      ) throw invalidCommandResult(commandId, "long-term consolidation mismatch");
    }
  }
}

function validateMemoryInput(
  archive: SimulationArchive,
  commandId: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
  commit: CommitRecord,
  commandKind: string,
): void {
  assertExactInput(commandId, input, [
    "ownerScope", "simulationId", "branchId", "expectedHead", "commandId", "payload",
  ]);
  if (!isRecord(input.payload) || !isRecord(result.branch))
    throw invalidCommandResult(commandId, "invalid memory input");
  const payload = input.payload;
  const revision = commandKind === "revise_memory";
  assertExactInput(commandId, payload, revision
    ? ["actorId", "memoryId", "revisesOperationId", "content"]
    : ["actorId", "memoryId", "retractsOperationId"]);
  if (
    input.branchId !== result.branch.id ||
    input.expectedHead !== commit.parentCommitId ||
    commit.events.length !== 1 ||
    commit.events[0]?.type !== "memory_operation"
  ) throw invalidCommandResult(commandId, "memory command basis mismatch");
  const operation = commit.events[0].operation;
  const ancestry = ancestryThrough(archive.commits, commit.parentCommitId);
  const operations = ancestry.flatMap((item) => [
    ...legacyClosureOperations(item),
    ...(archive.detachedMemoryOperations || []).filter(
      (operation) => operation.closureCommitId === item.id,
    ),
    ...item.events.filter((event) => event.type === "memory_operation")
      .map((event) => event.type === "memory_operation" ? event.operation : neverValue()),
  ]);
  const current = operations.filter((item) => item.memoryId === payload.memoryId).at(-1);
  const target = revision ? payload.revisesOperationId : payload.retractsOperationId;
  if (
    !current || current.type === "retracted" ||
    current.id !== target || current.actorId !== payload.actorId ||
    operation.memoryId !== current.memoryId || operation.actorId !== current.actorId ||
    operation.memoryKind !== current.memoryKind ||
    stableStringify(operation.sourcePerceptionIds) !==
      stableStringify(current.sourcePerceptionIds) ||
    stableStringify(operation.sourceEventIds) !==
      stableStringify(current.sourceEventIds) ||
    stableStringify(operation.sourceMessageVersionIds) !==
      stableStringify(current.sourceMessageVersionIds) ||
    operation.basisCommitId !== commit.parentCommitId ||
    operation.closureCommitId !== null || operation.producer.mode !== "manual" ||
    operation.producer.commandId !== commandId ||
    operation.id !== domainId("memory_operation", archive.simulation.ownerScope, archive.simulation.id, commandId)
  ) throw invalidCommandResult(commandId, "memory operation chain mismatch");
  if (revision) {
    const content = requiredInputString(commandId, payload, "content").trim();
    if (!content || operation.type !== "revised" || operation.content !== content || operation.revisesOperationId !== current.id)
      throw invalidCommandResult(commandId, "memory revision mismatch");
  } else if (operation.type !== "retracted" || operation.retractsOperationId !== current.id)
    throw invalidCommandResult(commandId, "memory retraction mismatch");
  validateMemoryOperationBasis(
    archive, commit, operation,
    new Map(projectPerceptions(ancestry).map((item) => [item.id, item])),
  );
}

function validateMemoryOperationBasis(
  archive: SimulationArchive,
  commit: CommitRecord,
  operation: Extract<RuntimeEvent, { type: "memory_operation" }>["operation"],
  perceptions: Map<string, ReturnType<typeof projectPerceptions>[number]>,
): void {
  requireArchiveActor(archive, commit.commandId, operation.actorId);
  if (
    operation.simulationId !== archive.simulation.id ||
    operation.createdAt !== commit.createdAt ||
    !isAncestor(archive.commits, operation.basisCommitId, commit.parentCommitId || commit.id) ||
    new Set(operation.sourcePerceptionIds).size !== operation.sourcePerceptionIds.length ||
    new Set(operation.sourceEventIds).size !== operation.sourceEventIds.length ||
    new Set(operation.sourceMessageVersionIds).size !== operation.sourceMessageVersionIds.length
  ) throw invalidCommandResult(commit.commandId, "memory operation basis mismatch");
  const sources = operation.sourcePerceptionIds.map((id) => perceptions.get(id));
  if (sources.some((item) => !item || item.actorId !== operation.actorId))
    throw invalidCommandResult(commit.commandId, "memory perception provenance mismatch");
  if (
    stableStringify(sources.map((item) => item!.sourceEventId)) !== stableStringify(operation.sourceEventIds) ||
    stableStringify(sources.map((item) => item!.sourceMessageVersionId)) !== stableStringify(operation.sourceMessageVersionIds)
  ) throw invalidCommandResult(commit.commandId, "memory source provenance mismatch");
}

function neverValue(): never {
  throw new Error("Unreachable runtime event.");
}

function addUniqueClosureId(commandId: string, ids: Set<string>, id: string): void {
  if (ids.has(id)) throw invalidCommandResult(commandId, "duplicate closure record ID");
  ids.add(id);
}

function isBeliefStrength(value: number): boolean {
  return [-3, -1, 0, 1, 3].includes(value);
}

function validateForkInput(
  archive: SimulationArchive,
  command: SimulationArchive["commandResults"][number],
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): void {
  assertExactInput(command.commandId, input, [
    "ownerScope", "simulationId", "sourceBranchId", "expectedHead",
    "atCommitId", "branchId", "commandId", "name?",
  ]);
  if (!isRecord(result.branch))
    throw invalidCommandResult(command.commandId, "invalid fork result");
  const source = archive.branches.find(
    (branch) => branch.id === input.sourceBranchId,
  );
  const origin = isRecord(result.branch.origin) ? result.branch.origin : null;
  if (
    !source ||
    input.branchId !== result.branch.id ||
    input.atCommitId !== result.branch.headCommitId ||
    result.branch.name !== (input.name || null) ||
    !origin ||
    origin.kind !== "fork" ||
    origin.commandId !== command.commandId ||
    origin.sourceBranchId !== input.sourceBranchId ||
    origin.sourceHeadCommitId !== input.expectedHead ||
    origin.baseCommitId !== input.atCommitId ||
    !isAncestor(
      archive.commits,
      String(input.atCommitId),
      String(input.expectedHead),
    )
  )
    throw invalidCommandResult(command.commandId, "input fork mismatch");
}

function validateWhisperInput(
  archive: SimulationArchive,
  command: SimulationArchive["commandResults"][number],
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): void {
  assertExactInput(command.commandId, input, [
    "ownerScope", "simulationId", "branchId", "expectedHead", "commandId",
    "targetActorId", "text",
  ]);
  const whisper = archive.stageWhispers.find(
    (item) => item.commandId === command.commandId,
  );
  if (whisper) requireArchiveActor(archive, command.commandId, whisper.targetActorId);
  if (
    !whisper ||
    whisper.id !== deterministicWhisperId(archive, command.commandId) ||
    stableStringify(whisper) !== stableStringify(result) ||
    input.branchId !== whisper.branchId ||
    input.expectedHead !== whisper.expectedHead ||
    input.targetActorId !== whisper.targetActorId ||
    requiredInputString(command.commandId, input, "text").trim() !== whisper.text
  )
    throw invalidCommandResult(command.commandId, "input whisper mismatch");
}

function assertExactInput(
  commandId: string,
  value: Record<string, unknown>,
  keys: string[],
): void {
  const required = keys.filter((key) => !key.endsWith("?"));
  const allowed = keys.map((key) => key.replace(/\?$/, ""));
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw invalidCommandResult(commandId, "input keys mismatch");
}

function requiredInputString(
  commandId: string,
  value: Record<string, unknown>,
  key: string,
): string {
  if (typeof value[key] !== "string")
    throw invalidCommandResult(commandId, `${key} is not a string`);
  return value[key];
}

function nullableInputString(
  commandId: string,
  value: unknown,
  key: string,
): string | null | undefined {
  if (value !== undefined && value !== null && typeof value !== "string")
    throw invalidCommandResult(commandId, `${key} is not nullable text`);
  return value as string | null | undefined;
}

function inputStringArray(
  commandId: string,
  value: unknown,
  key: string,
): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw invalidCommandResult(commandId, `${key} is not a string array`);
  return value;
}

function inputRecordArray(
  commandId: string,
  value: unknown,
  key: string,
): Array<Record<string, unknown>> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => !isRecord(item)))
    throw invalidCommandResult(commandId, `${key} is not a record array`);
  return value as Array<Record<string, unknown>>;
}

function validateCommitRecord(value: unknown): void {
  exact(value, [
    "id", "ownerScope", "simulationId", "parentCommitId", "kind",
    "commandId", "events", "createdAt",
  ], "commit");
  const commit = value as Record<string, unknown>;
  stringsOf(commit, ["id", "ownerScope", "simulationId", "commandId", "createdAt"], "commit");
  if (commit.parentCommitId !== null && typeof commit.parentCommitId !== "string")
    invalid("commit parent");
  if (!["root", "turn", "effects", "episode_closure", "memory"].includes(String(commit.kind)))
    invalid("commit kind");
  if (!Array.isArray(commit.events)) invalid("commit events");
}

function validateBranchRecord(value: unknown): void {
  exact(
    value,
    [
      "id", "ownerScope", "simulationId", "name", "headCommitId", "origin",
      "createdAt",
    ],
    "branch",
  );
  const branch = value as Record<string, unknown>;
  stringsOf(
    branch,
    ["id", "ownerScope", "simulationId", "headCommitId", "createdAt"],
    "branch",
  );
  nullableString(branch.name, "branch name");
  if (!isRecord(branch.origin)) invalid("branch origin");
  const origin = branch.origin;
  if (origin.kind === "root") {
    exact(origin, ["kind", "commandId", "baseCommitId"], "root branch origin");
    stringsOf(origin, ["commandId", "baseCommitId"], "root branch origin");
    return;
  }
  exact(
    origin,
    [
      "kind", "commandId", "sourceBranchId", "sourceHeadCommitId",
      "baseCommitId",
    ],
    "branch origin",
  );
  oneOf(origin.kind, ["fork", "edit", "regenerate"], "branch origin kind");
  stringsOf(
    origin,
    ["commandId", "sourceBranchId", "sourceHeadCommitId", "baseCommitId"],
    "branch origin",
  );
}

function validateRuntimeEvent(value: unknown): void {
  if (!isRecord(value) || typeof value.type !== "string") invalid("runtime event");
  if (value.type === "message_accepted") {
    exact(value, ["type", "message"], "message event");
    validateMessage(value.message);
  } else if (value.type === "audience_changed") {
    exact(value, ["type", "actorId", "action", "reason"], "audience event");
    stringsOf(value, ["actorId"], "audience event");
    oneOf(value.action, ["add", "remove", "deactivate", "reactivate"], "audience action");
    nullableString(value.reason, "audience reason");
  } else if (value.type === "access_changed") {
    exact(value, ["type", "action", "member", "container", "mode", "reason"], "access event");
    stringsOf(value, ["member", "container"], "access event");
    oneOf(value.action, ["grant", "revoke"], "access action");
    oneOf(value.mode, ["member"], "access mode");
    nullableString(value.reason, "access reason");
  } else if (value.type === "first_impression_formed") {
    exact(value, ["type", "impression"], "impression event");
    validateImpression(value.impression, false);
  } else if (value.type === "stage_whisper_consumed") {
    exact(value, ["type", "whisperId", "targetActorId", "text"], "whisper event");
    stringsOf(value, ["whisperId", "targetActorId", "text"], "whisper event");
  } else if (value.type === "episode_closed") {
    exact(value, ["type", "closure"], "closure event");
    validateClosure(value.closure);
  } else if (value.type === "memory_operation") {
    exact(value, ["type", "operation"], "memory operation event");
    validateMemoryOperation(value.operation);
  } else invalid("runtime event type");
}

function validateMessage(value: unknown): void {
  exact(value, ["id", "logicalMessageId", "actorId", "text", "audience", "provenance"], "message");
  const item = value as Record<string, unknown>;
  stringsOf(item, ["id", "logicalMessageId", "actorId", "text"], "message");
  stringArray(item.audience, "message audience");
  const provenance = item.provenance as Record<string, unknown>;
  if (provenance.mode === "manual") {
    exact(provenance, ["mode", "operation"], "message provenance");
    oneOf(
      provenance.operation,
      ["turn", "edit", "regenerate"],
      "message operation",
    );
  } else {
    exact(
      provenance,
      ["mode", "operation", "sourceArtifactDigest", "finalTextSource"],
      "generated message provenance",
    );
    oneOf(provenance.mode, ["generated"], "generated message provenance mode");
    oneOf(provenance.operation, ["turn"], "generated message operation");
    stringsOf(provenance, ["sourceArtifactDigest"], "generated message provenance");
    oneOf(
      provenance.finalTextSource,
      ["generated_verbatim", "acceptor_edited"],
      "generated final text source",
    );
  }
}

function validateClosure(value: unknown): void {
  exact(
    value,
    [
      "episode",
      "memories",
      "longTermMemories",
      "extractedBeliefs",
      "retainedBeliefs",
      ...(isRecord(value) && Object.hasOwn(value, "memoryOperations") ? ["memoryOperations"] : []),
    ],
    "closure",
  );
  const closure = value as Record<string, unknown>;
  record(
    closure.episode,
    ["id", "simulationId", "commitId", "label", "closedAt"],
    "episode",
    ["id", "simulationId", "commitId", "closedAt"],
  );
  nullableString(
    (closure.episode as Record<string, unknown>).label,
    "episode label",
  );
  arrayOf(closure.memories, validateEpisodeMemory, "episode memories");
  arrayOf(closure.longTermMemories, validateLongMemory, "long-term memories");
  arrayOf(
    closure.extractedBeliefs,
    validateExtractedBelief,
    "extracted beliefs",
  );
  arrayOf(closure.retainedBeliefs, validateRetainedBelief, "retained beliefs");
  if (closure.memoryOperations !== undefined)
    arrayOf(closure.memoryOperations, validateMemoryOperation, "memory operations");
}

function validateEpisodeMemory(value: unknown): void {
  record(
    value,
    [
      "id",
      "episodeId",
      "simulationId",
      "actorId",
      "text",
      "sourceTurnIds",
      "createdAt",
      ...(isRecord(value) && Object.hasOwn(value, "sourcePerceptionIds") ? ["sourcePerceptionIds"] : []),
      ...(isRecord(value) && Object.hasOwn(value, "sourceEventIds") ? ["sourceEventIds"] : []),
      ...(isRecord(value) && Object.hasOwn(value, "sourceMessageVersionIds") ? ["sourceMessageVersionIds"] : []),
    ],
    "episode memory",
    ["id", "episodeId", "simulationId", "actorId", "text", "createdAt"],
  );
  stringArray((value as Record<string, unknown>).sourceTurnIds, "source turn IDs");
  const memory = value as Record<string, unknown>;
  for (const key of ["sourcePerceptionIds", "sourceEventIds", "sourceMessageVersionIds"])
    if (memory[key] !== undefined) stringArray(memory[key], key);
}
function validateMemoryOperation(value: unknown): void {
  if (!isRecord(value)) invalid("memory operation");
  const type = value.type;
  oneOf(type, ["asserted", "consolidated", "revised", "retracted"], "memory operation type");
  const common = [
    "id", "memoryId", "simulationId", "actorId", "memoryKind", "type",
    "basisCommitId", "closureCommitId", "sourcePerceptionIds", "sourceEventIds",
    "sourceMessageVersionIds", "producer", "createdAt",
  ];
  const tail = type === "consolidated" ? ["content", "episodeMemoryId"]
    : type === "revised" ? ["content", "revisesOperationId"]
    : type === "retracted" ? ["retractsOperationId"] : ["content"];
  exact(value, [...common, ...tail], "memory operation");
  stringsOf(value, ["id", "memoryId", "simulationId", "actorId", "basisCommitId", "createdAt"], "memory operation");
  oneOf(value.memoryKind, ["episode", "long_term"], "memory kind");
  nullableString(value.closureCommitId, "closure commit");
  stringArray(value.sourcePerceptionIds, "source perceptions");
  stringArray(value.sourceEventIds, "source events");
  stringArray(value.sourceMessageVersionIds, "source message versions");
  if (type !== "retracted" && typeof value.content !== "string") invalid("memory content");
  if (type === "consolidated" && typeof value.episodeMemoryId !== "string") invalid("episode memory ID");
  if (type === "revised" && typeof value.revisesOperationId !== "string") invalid("revised operation ID");
  if (type === "retracted" && typeof value.retractsOperationId !== "string") invalid("retracted operation ID");
  exact(value.producer, ["mode", "commandId"], "memory producer");
  const producer = value.producer as Record<string, unknown>;
  oneOf(producer.mode, ["episode_closure", "manual", "legacy_closure"], "memory producer mode");
  stringsOf(producer, ["commandId"], "memory producer");
}
function validateLongMemory(value: unknown): void {
  record(
    value,
    [
      "id",
      "episodeId",
      "episodeMemoryId",
      "simulationId",
      "actorId",
      "text",
      "createdAt",
    ],
    "long-term memory",
    [
      "id",
      "episodeId",
      "episodeMemoryId",
      "simulationId",
      "actorId",
      "text",
      "createdAt",
    ],
  );
}
function validateExtractedBelief(value: unknown): void {
  record(
    value,
    [
      "id",
      "episodeId",
      "memoryId",
      "simulationId",
      "holder",
      "strength",
      "propositionText",
      "createdAt",
    ],
    "extracted belief",
    [
      "id",
      "episodeId",
      "memoryId",
      "simulationId",
      "holder",
      "propositionText",
      "createdAt",
    ],
  );
  number((value as Record<string, unknown>).strength, "belief strength");
}
function validateRetainedBelief(value: unknown): void {
  record(
    value,
    [
      "id",
      "episodeId",
      "simulationId",
      "holder",
      "strength",
      "propositionText",
      "sourceHolder",
      "accessPath",
      "sourceBelief",
      "runtimeAccessEventId",
      "createdAt",
    ],
    "retained belief",
    [
      "id",
      "episodeId",
      "simulationId",
      "holder",
      "propositionText",
      "sourceHolder",
      "runtimeAccessEventId",
      "createdAt",
    ],
  );
  const item = value as Record<string, unknown>;
  number(item.strength, "retained belief strength");
  stringArray(item.accessPath, "retained belief access path");
  validateSourceBelief(item.sourceBelief);
}
function validateSourceBelief(value: unknown): void {
  if (!isRecord(value)) invalid("source belief");
  if (Object.hasOwn(value, "memoryId")) validateExtractedBelief(value);
  else if (Object.hasOwn(value, "observerId")) validateImpression(value, true);
  else {
    record(value, ["holder", "strength", "propositionText", "mentions", "sourceSpan"], "authored belief", ["holder", "propositionText"]);
    number(value.strength, "authored belief strength");
    stringArray(value.mentions, "belief mentions");
    validateSourceSpan(value.sourceSpan);
  }
}
function validateImpression(value: unknown, complete: boolean): void {
  const keys = ["holder", "observerId", "entityId", "strength", "propositionText", "surfaceSourceSpan"];
  if (complete) keys.push("id", "simulationId", "createdAt");
  const stringKeys = [
    "holder",
    "observerId",
    "entityId",
    "propositionText",
  ];
  if (complete) stringKeys.push("id", "simulationId", "createdAt");
  record(value, keys, "first impression", stringKeys);
  number((value as Record<string, unknown>).strength, "impression strength");
  validateSourceSpan((value as Record<string, unknown>).surfaceSourceSpan);
}
function validateSourceSpan(value: unknown): void {
  record(value, ["file", "line", "quote"], "source span", ["file", "quote"]);
  number((value as Record<string, unknown>).line, "source span line");
}
function exact(value: unknown, keys: string[], label: string): void {
  if (!isRecord(value) || !sameKeys(Object.keys(value).sort(), keys)) invalid(label);
}
function record(value: unknown, keys: string[], label: string, stringKeys: string[]): void {
  exact(value, keys, label);
  stringsOf(value as Record<string, unknown>, stringKeys, label);
}
function stringsOf(value: Record<string, unknown>, keys: string[], label: string): void {
  if (keys.some((key) => typeof value[key] !== "string")) invalid(label);
}
function stringArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) invalid(label);
}
function arrayOf(value: unknown, validator: (item: unknown) => void, label: string): void {
  if (!Array.isArray(value)) invalid(label);
  for (const item of value) validator(item);
}
function number(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(label);
}
function nullableString(value: unknown, label: string): void {
  if (value !== null && typeof value !== "string") invalid(label);
}
function oneOf(value: unknown, choices: string[], label: string): void {
  if (typeof value !== "string" || !choices.includes(value)) invalid(label);
}
function invalid(label: string): never {
  throw new Error(`Simulation archive contains invalid ${label}.`);
}

function validateCommandResult(
  archive: SimulationArchive,
  commandId: string,
  outcome: SimulationArchive["commandResults"][number]["result"],
): void {
  if (!isRecord(outcome))
    throw invalidCommandResult(commandId, "result is not an object");
  const expectedKeys = outcome.kind === "start"
    ? [
        "kind", "simulation", "branch", "root",
        ...(Object.hasOwn(outcome, "contentRevision") ? ["contentRevision"] : []),
      ]
    : outcome.kind === "commit"
      ? ["kind", "branch", "commit"]
      : outcome.kind === "branch"
        ? ["kind", "branch"]
        : outcome.kind === "whisper"
          ? ["kind", "whisper"]
          : [];
  if (!expectedKeys.length || !sameKeys(Object.keys(outcome).sort(), expectedKeys))
    throw invalidCommandResult(commandId, "invalid recorded outcome shape");
  const value = unwrapRecordedOutcome(outcome) as Record<string, unknown>;
  if (outcome.kind === "commit") {
    validateCommitResult(archive, commandId, value);
    return;
  }
  if (outcome.kind === "branch") {
    validateBranchResult(archive, commandId, value);
    return;
  }
  if (outcome.kind === "start") {
    validateStartResult(archive, commandId, value);
    return;
  }
  if (outcome.kind === "whisper") {
    validateWhisperResult(archive, commandId, value);
    return;
  }
  throw invalidCommandResult(commandId, "unknown result shape");
}

function validateCommitResult(
  archive: SimulationArchive,
  commandId: string,
  value: Record<string, unknown>,
): void {
  if (!isRecord(value.commit) || !isRecord(value.branch))
    throw invalidCommandResult(commandId, "invalid commit result records");
  const resultCommit = value.commit;
  const resultBranch = value.branch;
  const commit = archive.commits.find((item) => item.id === resultCommit.id);
  const branch = archive.branches.find((item) => item.id === resultBranch.id);
  if (
    !commit ||
    !branch ||
    commit.commandId !== commandId ||
    stableStringify(commit) !== stableStringify(resultCommit) ||
    resultBranch.ownerScope !== archive.simulation.ownerScope ||
    resultBranch.simulationId !== archive.simulation.id ||
    resultBranch.name !== branch.name ||
    resultBranch.createdAt !== branch.createdAt ||
    stableStringify(resultBranch.origin) !== stableStringify(branch.origin) ||
    resultBranch.headCommitId !== commit.id ||
    !isAncestor(archive.commits, commit.id, branch.headCommitId)
  )
    throw invalidCommandResult(
      commandId,
      "commit or branch does not match history",
    );
}

function validateBranchResult(
  archive: SimulationArchive,
  commandId: string,
  value: Record<string, unknown>,
): void {
  if (!isRecord(value.branch))
    throw invalidCommandResult(commandId, "invalid branch result record");
  const resultBranch = value.branch;
  const branch = archive.branches.find((item) => item.id === resultBranch.id);
  if (
    !branch ||
    resultBranch.ownerScope !== archive.simulation.ownerScope ||
    resultBranch.simulationId !== archive.simulation.id ||
    typeof resultBranch.headCommitId !== "string" ||
    resultBranch.name !== branch.name ||
    resultBranch.createdAt !== branch.createdAt ||
    stableStringify(resultBranch.origin) !== stableStringify(branch.origin) ||
    !isAncestor(archive.commits, resultBranch.headCommitId, branch.headCommitId)
  )
    throw invalidCommandResult(commandId, "branch does not match history");
}

function validateStartResult(
  archive: SimulationArchive,
  commandId: string,
  value: Record<string, unknown>,
): void {
  if (
    !isRecord(value.simulation) ||
    !isRecord(value.root) ||
    !isRecord(value.branch)
  )
    throw invalidCommandResult(commandId, "invalid start result records");
  const resultRoot = value.root;
  const resultBranch = value.branch;
  const root = archive.commits.find((item) => item.id === resultRoot.id);
  const branch = archive.branches.find(
    (item) => item.id === archive.simulation.defaultBranchId,
  );
  if (
    stableStringify(value.simulation) !== stableStringify(archive.simulation) ||
    value.contentRevision !== undefined &&
      stableStringify(value.contentRevision) !==
        stableStringify(archive.contentRevision) ||
    !root ||
    root.commandId !== commandId ||
    root.kind !== "root" ||
    root.parentCommitId !== null ||
    stableStringify(root) !== stableStringify(resultRoot) ||
    !branch ||
    resultBranch.id !== branch.id ||
    resultBranch.ownerScope !== branch.ownerScope ||
    resultBranch.simulationId !== branch.simulationId ||
    resultBranch.name !== branch.name ||
    resultBranch.createdAt !== branch.createdAt ||
    stableStringify(resultBranch.origin) !== stableStringify(branch.origin) ||
    resultBranch.headCommitId !== root.id ||
    !isAncestor(archive.commits, root.id, branch.headCommitId)
  )
    throw invalidCommandResult(
      commandId,
      "start result does not match archive roots",
    );
}

function validateWhisperResult(
  archive: SimulationArchive,
  commandId: string,
  value: Record<string, unknown>,
): void {
  const whisper = archive.stageWhispers.find((item) => item.id === value.id);
  if (
    !whisper ||
    whisper.commandId !== commandId ||
    stableStringify(whisper) !== stableStringify(value)
  )
    throw invalidCommandResult(
      commandId,
      "whisper does not match runtime state",
    );
}

function isAncestor(
  commits: CommitRecord[],
  ancestorId: string,
  headId: string,
): boolean {
  const byId = new Map(commits.map((commit) => [commit.id, commit]));
  let cursor: string | null = headId;
  while (cursor) {
    if (cursor === ancestorId) return true;
    cursor = byId.get(cursor)?.parentCommitId || null;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sameKeys(actual: string[], expected: string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

function invalidCommandResult(commandId: string, reason: string): Error {
  return new Error(
    `Simulation archive command result is invalid for ${commandId}: ${reason}.`,
  );
}

function validateAcceptedDraftCommandShape(
  archive: SimulationArchive,
  command: SimulationArchive["commandResults"][number],
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): void {
  if (archive.schemaVersion !== 6)
    throw invalidCommandResult(command.commandId, "draft acceptance requires schema v6");
  assertExactInput(command.commandId, input, [
    "ownerScope", "simulationId", "branchId", "expectedHead",
    "commandId", "payload",
  ]);
  if (!isRecord(result.commit) || !isRecord(result.branch))
    throw invalidCommandResult(command.commandId, "invalid accepted draft result");
  let receipt: AcceptDraftReceipt;
  try {
    receipt = decodeAcceptDraftReceipt(input.payload);
  } catch {
    throw invalidCommandResult(command.commandId, "accepted draft receipt is invalid");
  }
  const resultCommit = result.commit;
  const commit = archive.commits.find((item) => item.id === resultCommit.id);
  const branch = archive.branches.find((item) => item.id === input.branchId);
  if (
    !commit ||
    !branch ||
    input.ownerScope !== archive.simulation.ownerScope ||
    input.simulationId !== archive.simulation.id ||
    input.commandId !== command.commandId ||
    receipt.draftId !== domainId(
      "actor_turn_draft",
      archive.simulation.ownerScope,
      archive.simulation.id,
      receipt.generationCommandId,
    ) ||
    receipt.contentRevisionId !== archive.simulation.contentRevisionId ||
    commit.id !== domainId(
      "commit",
      archive.simulation.ownerScope,
      archive.simulation.id,
      command.commandId,
    ) ||
    commit.ownerScope !== archive.simulation.ownerScope ||
    commit.simulationId !== archive.simulation.id ||
    commit.kind !== "turn" ||
    commit.commandId !== command.commandId ||
    commit.parentCommitId !== input.expectedHead ||
    result.branch.id !== input.branchId ||
    result.branch.ownerScope !== archive.simulation.ownerScope ||
    result.branch.simulationId !== archive.simulation.id ||
    result.branch.headCommitId !== commit.id ||
    !isAncestor(archive.commits, branch.origin.baseCommitId, String(input.expectedHead)) ||
    !isAncestor(archive.commits, commit.id, branch.headCommitId) ||
    stableStringify(result.commit) !== stableStringify(commit) ||
    result.branch.name !== branch.name ||
    result.branch.createdAt !== branch.createdAt ||
    stableStringify(result.branch.origin) !== stableStringify(branch.origin)
  )
    throw invalidCommandResult(command.commandId, "accepted draft basis mismatch");
  requireArchiveActor(archive, command.commandId, receipt.actorId);
  if (
    stableStringify(receipt.audience) !==
    stableStringify(normalizeAudience(receipt.actorId, receipt.audience))
  ) throw invalidCommandResult(command.commandId, "accepted draft audience is not normalized");
  for (const actorId of receipt.audience)
    requireArchiveActor(archive, command.commandId, actorId);
  const artifact = receipt.generatedArtifact;
  // Prompt policy, output schema, skills, and context/prompt hashes occur once in
  // the self-contained receipt. Their shape is validated by the codec, but they
  // remain recorded claims until a signed/preimage-bearing format exists.
  if (
    stableStringify(artifact.provenance.runtimeProfile) !==
      stableStringify(receipt.runtimeProfile)
  ) throw invalidCommandResult(command.commandId, "accepted draft artifact provenance is invalid");
  const finalText = receipt.accepted.textSource === "generated_verbatim"
    ? artifact.text
    : receipt.accepted.text;
  if (
    receipt.accepted.textSource === "acceptor_edited" &&
    receipt.accepted.text === artifact.text
  ) throw invalidCommandResult(command.commandId, "accepted draft edit must differ from generated text");
  const message = {
    id: domainId(
      "message_version",
      archive.simulation.ownerScope,
      archive.simulation.id,
      command.commandId,
    ),
    logicalMessageId: domainId(
      "message",
      archive.simulation.ownerScope,
      archive.simulation.id,
      command.commandId,
    ),
    actorId: receipt.actorId,
    text: finalText,
    audience: receipt.audience,
    provenance: {
      mode: "generated" as const,
      operation: "turn" as const,
      sourceArtifactDigest: artifact.digest,
      finalTextSource: receipt.accepted.textSource,
    },
  };
  const whispers = receipt.stageWhispers.map((snapshot) => {
    const whisper = archive.stageWhispers.find((item) => item.id === snapshot.id);
    if (
      !whisper ||
      whisper.text !== snapshot.text ||
      whisper.ownerScope !== archive.simulation.ownerScope ||
      whisper.simulationId !== archive.simulation.id ||
      whisper.branchId !== input.branchId ||
      whisper.expectedHead !== input.expectedHead ||
      whisper.targetActorId !== receipt.actorId
    ) throw invalidCommandResult(command.commandId, "accepted draft whisper snapshot is invalid");
    return whisper;
  });
  const consumed = new Set(
    ancestryThrough(archive.commits, commit.parentCommitId).flatMap((ancestor) =>
      ancestor.events.flatMap((event) =>
        event.type === "stage_whisper_consumed" ? [event.whisperId] : [],
      ),
    ),
  );
  if (whispers.some((whisper) => consumed.has(whisper.id)))
    throw invalidCommandResult(command.commandId, "accepted draft whisper was already consumed");
  const expectedEvents: RuntimeEvent[] = [
    { type: "message_accepted", message },
    ...expectedFirstImpressionEvents(archive, commit, receipt.audience),
    ...buildStageWhisperEvents({
      ownerScope: archive.simulation.ownerScope,
      simulationId: archive.simulation.id,
      commandId: command.commandId,
      actorId: receipt.actorId,
      selected: whispers,
    }),
  ];
  if (stableStringify(commit.events) !== stableStringify(expectedEvents))
    throw invalidCommandResult(command.commandId, "accepted draft event sequence is invalid");
}
