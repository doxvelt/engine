# Picker-driven candidate routing (#16)

This bounded contract follows the approved separation of observation/access from
tentative delivery. It does not implement notation grammar or historical revision.

## Version and observation boundary

Legacy text-only requests, saved drafts and receipts retain their original context
interpretation. New Stage requests explicitly select `audience-proposal-v1`.
For this policy, observations come from the branch's explicit active presence
roster, only when the acting identity is itself active. Empty/inactive presence
supplies no other surfaces. Existing access links, beliefs, memories and perceived
transcript remain branch-relative. Delivery selections never grant surfaces or
dossiers, and do not change presence.

Proposal identities are supported pinned IDs referenced in actor-visible material,
observed identities, and draft-local explicit director references. A director may
select identities or name an unambiguous public name/ID in private direction;
this supplies only a safe identity reference, never persistent knowledge. Unknown
explicit IDs fail closed. A mentioned person is not automatically a recipient.

## Candidate lifecycle

One fixed actor receives the original private whisper. Initial recipients are
tentative, including no selection. The runtime returns structured performance and
recipient IDs; no tools execute. The server validates the whole result before it
becomes ready. There is no public/All fallback and no separate proposal mode.

Corrections create distinct durable candidates at the source basis. They retain
source/original identity, original whispers and explicit correction input. Corrected
recipients are authoritative; a generated contradiction fails. Exact request replay
returns the same candidate. A different actor requires a fresh operation.

The director can explicitly preserve the current editor wording in a new candidate.
This is a director-derived artifact, with source artifact/provenance retained; it
does not claim a model generated that wording under the new context. Context and
recipient validation run again. This is supported only with the empty capability
grant. The director reviews exact text and concrete recipients before accepting.
No semantic suitability guarantee is inferred from hashes or an LLM.

Acceptance never changes routing. It atomically records final delivery, derived
perceptions, first impressions and selected-whisper consumption. Unaccepted
candidates have no canonical effects. Original candidates remain available.

## Compatibility and review

Receipt v2 routing metadata is self-contained in accepted receipts, including
source derivation; operational drafts remain outside exports. Old v1 receipt decoding
and historical context remain unchanged. Review exposes original whisper, initial
direction, final recipients and derivation, not raw context/prompt. Existing legacy
transport policy is not expanded; its broader minimization belongs to #17.

Stage whisper and Perform have independent prose and routing. Perform stays
immediate. All explicitly selects pinned IDs and permits individual deselection.
Notation/escaping/display and device/accessibility acceptance remain open #16 gates.
Bounded automated browser evidence is recorded in the implementation PR.

## Regression ledger

- Subjectivity: same-head audience changes expose no surfaces; inactive/absent
  third parties stay hidden; explicit references reveal identity only; legacy
  accepted history and legacy draft context interpretation remain unchanged.
- Direction: fixed actor, private original whisper, mentions do not deliver,
  no-selection generation, invalid/unsupported identity and contradictory output fail.
- Identity: new correction candidate, exact replay, source/original provenance,
  preserved edited wording, authoritative correction on retry, no accept retagging.
- Effects: empty tools, no pre-accept canonical changes, final recipients plus
  sender, correct first impressions/whisper consumption, stale/race/rollback gates.
- Durability: restart and lost responses, command fingerprints, discovery,
  archive replay without drafts, forged routing/provenance rejected.
- UI: visible changes and recipients, separate whisper/performance, mode isolation,
  preserved editor state, correction review, scope guards and convergence leases.

Archive verification checks source identities, corrected/proposed recipients,
artifact digests, derivation attribution and exact committed effects. As with v1,
historical model/source-artifact and prompt/context hash claims are not signed
proof of model execution; archives do not export raw actor prompts or contexts.

## Application and transport seams

- `generateActorTurnDraft` accepts an optional versioned routing input. Its
  absence retains legacy behavior. The Pi transport remains text-only and
  tool-free; the proposal policy requires exact JSON `{ text, audience }` and
  core validates that structure before completing an artifact. New artifact
  digests bind both performance and recipients.
- Stage posts `draftingPolicy: "audience-proposal-v1"` to `/drafts`; an absent or
  null audience means unspecified direction under this policy only.
- `/drafts/:id/revise` takes command ID, explicit audience, correction text and
  optional exact `preservedText`. The server supplies source actor/basis/whispers.
  `/retry` repeats captured input. Acceptance rejects routing fields.
- New-policy generation, detail, retry, revision, discard (including replay) and discovery return the shared
  Stage review projection. Original whisper, initial direction and authoritative
  correction are visible independently from proposed performance/recipients.
  Pending/failed drafts do not display tentative recipients as model proposals.
- Unsaved corrections block Accept and ordinary Retry until applied through a
  replacement or explicitly cleared. Editor buffers survive switching candidates;
  pending-to-ready recovery initializes correction controls from the valid result.
  Terminal candidates with unsent edits remain recoverable by their original ID
  in Saved drafts, including while composing another turn. Terminal review exposes
  retained correction text/recipients and an explicit clear action; it never binds
  those edits to another candidate. These buffers remain session-local.

## Implementation validation boundary

Behavioral coverage is in `candidate-routing.test.ts`,
`candidate-routing-api.test.ts`, the additional Pi proposal test and Stage session
recovery tests, alongside existing draft/acceptance/archive/package/lease tests.
The API tests invoke the actual request listener in-process, without a listener
socket; they are not browser or network acceptance.

The two existing fixture adjustments retain their assertions: explicit All now
selects concrete IDs instead of depending on the old whisper default, and the
terminal-lease fixture mirrors nullable direction plus normalized draft recipients.
Notation parsing/roundtrip and device/accessibility acceptance remain outside this
slice. The implementation PR records independently executed aggregate gates,
bounded browser workflows and live-model observations; fixture coverage does not
establish general model instruction-following quality.
