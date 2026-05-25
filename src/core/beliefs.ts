import type { BeliefProvenance, SubjectiveBeliefRecord } from "./types.ts";

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
