import { assertExpectedBranchHead, projectBranch } from "./branch-kernel.ts";
import { domainId, fingerprintCommand } from "./domain-rules.ts";
import { assertRuntimeText, requiredSafeIdentifier } from "./draft-contracts.ts";
import { DomainNotFoundError, DomainValidationError, type CorrectTurnBodyCommand, type SimulationRepository } from "./ports.ts";
import type { CommitRecord } from "./types.ts";

export function turnCorrectionEvent(payload: CorrectTurnBodyCommand["payload"]) {
  requiredSafeIdentifier(payload.messageVersionId, "messageVersionId");
  assertRuntimeText(payload.text, "Corrected performance");
  return { type: "message_body_corrected" as const, messageVersionId: payload.messageVersionId, text: payload.text.trim() };
}

export function correctTurnBody(repository: SimulationRepository, input: Omit<CorrectTurnBodyCommand, "kind" | "branchId">) {
  const event = turnCorrectionEvent(input.payload);
  const { ownerScope, simulationId, sourceBranchId, expectedHead, commandId } = input;
  const branchId = domainId("correction_branch", ownerScope, simulationId, commandId);
  const command: CorrectTurnBodyCommand = {
    ...input, kind: "correct_turn_body", branchId,
    payload: { messageVersionId: event.messageVersionId, text: event.text },
  };
  const fingerprint = fingerprintCommand(command);
  const replay = repository.replayCommand(ownerScope, simulationId, commandId, fingerprint);
  if (replay?.kind === "commit") return { branch: replay.branch, commit: replay.commit, replayed: true };
  const source = { ownerScope, simulationId, branchId: sourceBranchId, expectedHead };
  assertExpectedBranchHead(repository, source);
  const projection = projectBranch(repository, { ...source, head: expectedHead });
  const turn = projection.transcript.find(item => item.messageVersionId === event.messageVersionId);
  if (!turn) throw new DomainNotFoundError("The selected turn is unavailable on this path.");
  if (turn.text === event.text) throw new DomainValidationError("Change the wording before saving a correction.");

  const commit: CommitRecord = {
    id: domainId("commit", ownerScope, simulationId, commandId), ownerScope, simulationId,
    parentCommitId: expectedHead, kind: "effects", commandId, events: [event], createdAt: new Date().toISOString(),
  };
  return repository.appendCommitToNewBranch({
    sourceBranchId, expectedHead, branchId, name: "correction", atCommitId: expectedHead,
    originKind: "edit", commandInput: command, commandFingerprint: fingerprint, commit,
  });
}
