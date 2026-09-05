/** Shared by domain validation and actor pickers; no runtime or host imports. */
export function canOwnTurn(entity: { kind: string }): boolean {
  return entity.kind === "agent" || entity.kind === "affiliation" || entity.kind === "stateless";
}
