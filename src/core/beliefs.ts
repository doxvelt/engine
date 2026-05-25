import type {
  CurrentBeliefGroup,
  CurrentBeliefResolution,
  SubjectiveBeliefAccess,
  BeliefProvenance,
  SubjectiveBeliefRecord
} from "./types.ts";

export type RetainedBeliefDraft = {
  holder: string;
  strength: number;
  propositionText: string;
  provenance: BeliefProvenance;
  sourceBelief: SubjectiveBeliefRecord;
};

export function createRetainedBeliefDraft({
  holder,
  sourceBelief,
  previousProvenance
}: {
  holder: string;
  sourceBelief: SubjectiveBeliefRecord;
  previousProvenance: BeliefProvenance;
}): RetainedBeliefDraft {
  return {
    holder,
    strength: weakenRetainedStrength(sourceBelief.strength),
    propositionText: sourceBelief.propositionText,
    provenance: {
      mode: "retained_after_access_loss",
      holder,
      sourceHolder: previousProvenance.sourceHolder,
      accessPath: previousProvenance.accessPath
    },
    sourceBelief
  };
}

export function weakenRetainedStrength(strength: number): number {
  if (strength >= 3) return 1;
  if (strength > 0) return 1;
  if (strength <= -3) return -1;
  if (strength < 0) return -1;
  return 0;
}

export function resolveCurrentBeliefs(beliefAccess: SubjectiveBeliefAccess[]): CurrentBeliefResolution {
  const grouped = new Map<string, SubjectiveBeliefAccess[]>();

  for (const access of beliefAccess) {
    const key = currentBeliefKey(access);
    grouped.set(key, [...(grouped.get(key) || []), access]);
  }

  const groups: CurrentBeliefGroup[] = [];
  for (const [key, values] of grouped.entries()) {
    const sorted = [...values].sort(compareBeliefAccess);
    const current = sorted.at(0);
    if (!current) continue;

    const superseded: SubjectiveBeliefAccess[] = [];
    const conflicting: SubjectiveBeliefAccess[] = [];

    for (const access of sorted.slice(1)) {
      if (isConflictingBelief(current, access)) {
        conflicting.push(access);
      } else {
        superseded.push(access);
      }
    }

    groups.push({
      key,
      current: [current],
      superseded,
      conflicting
    });
  }

  return {
    current: groups.flatMap((group) => group.current),
    superseded: groups.flatMap((group) => group.superseded),
    conflicting: groups.flatMap((group) => group.conflicting),
    groups
  };
}

function currentBeliefKey(access: SubjectiveBeliefAccess): string {
  return `${beliefScope(access)}:${normalizeProposition(access.belief.propositionText)}`;
}

function beliefScope(access: SubjectiveBeliefAccess): string {
  if (access.provenance.mode === "accessed_through_membership") {
    return `live:${access.provenance.sourceHolder}`;
  }

  if (access.provenance.mode === "retained_after_access_loss") {
    return `retained:${access.provenance.sourceHolder}`;
  }

  if (access.provenance.mode === "observed") {
    return `observed:${access.provenance.sourceHolder}`;
  }

  return `held:${access.provenance.holder}`;
}

function normalizeProposition(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();
}

function compareBeliefAccess(left: SubjectiveBeliefAccess, right: SubjectiveBeliefAccess): number {
  const strengthDelta = Math.abs(right.belief.strength) - Math.abs(left.belief.strength);
  if (strengthDelta !== 0) return strengthDelta;

  const recencyDelta = beliefRecency(right.belief) - beliefRecency(left.belief);
  if (recencyDelta !== 0) return recencyDelta;

  return right.belief.strength - left.belief.strength;
}

function beliefRecency(belief: SubjectiveBeliefRecord): number {
  const idOffset = "id" in belief ? Number(belief.id) / 1_000_000 : 0;

  if ("createdAt" in belief) {
    const parsed = Date.parse(belief.createdAt);
    if (Number.isFinite(parsed)) return parsed + idOffset;
  }

  if ("id" in belief) {
    return Number(belief.id);
  }

  return belief.sourceSpan.line;
}

function isConflictingBelief(current: SubjectiveBeliefAccess, other: SubjectiveBeliefAccess): boolean {
  return Math.sign(current.belief.strength) !== 0
    && Math.sign(other.belief.strength) !== 0
    && Math.sign(current.belief.strength) !== Math.sign(other.belief.strength);
}
