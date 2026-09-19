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

Approved product correction **#29** replaces the ordinary additive correction
interaction: the director edits the previous **complete stage whisper**, then
generates afresh for the same actor at the unchanged pre-turn branch head. Each
successive editor opens the latest complete version, including an empty version.
Only that version and the pre-turn actor context enter the model. Neither old
whispers nor any prior unaccepted performance enter its prompt or context.
Deleting “elephant” therefore removes that instruction, rather than asking the
model to reconcile it with an additive correction.

Replacement input uses routing version 2 with `completeWhisper` (required, empty
allowed) and an empty legacy `correction` field. Source/original identity, original
whisper snapshots and source artifact hashes remain immutable provenance; they
are not runtime input. Original snapshots still identify the pending whispers
consumed atomically on acceptance; the receipt's versioned routing captures the
complete replacement that actually generated the candidate. No schema migration
or rewriting of existing candidate/receipt hashes occurs.

Recipient eligibility is recomputed from actor-visible pre-turn material, observed
presence, the complete whisper, and current explicit audience direction. Removed
mentions and source performances grant no identity references. Initial picker
direction remains tentative. An explicit replacement audience is authoritative
and supersedes that initial direction for runtime eligibility; its contradiction
fails validation. `audience: null` explicitly requests a fresh proposal while
retaining the original tentative picker direction. Editing whisper prose alone
does not silently change an explicit audience decision.

Compatibility is deliberately bounded: routing version 1 requests, saved
candidates and receipts retain additive semantics, including their captured
source-material interpretation. Exact command replay returns the existing record.
Retry repeats captured input and verifies matching prompt/context hashes, including
older corrections that never included source performance. Legacy additive
corrections (and multi-whisper inputs) have no recoverable complete whisper. Stage
labels that limitation and requires explicitly entered complete direction, or
confirmation of an empty replacement; it never concatenates old corrections into
an invented whisper. Accepting/retrying a legacy record does not migrate it.

The director can explicitly preserve the current editor wording in a new candidate.
A changed or unresolved whisper must be generated instead; preserving wording
only changes explicit delivery with the same complete whisper. This is a
director-derived artifact, with source artifact/provenance retained; it
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
and historical context remain unchanged. Review exposes the candidate’s complete
whisper (or unresolved legacy input), original whisper provenance, initial direction,
final recipients and derivation, not raw context/prompt. Existing legacy
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
- Identity: new complete-whisper candidate, exact replay, source/original provenance,
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
- `/drafts/:id/revise` takes command ID, `completeWhisper`, nullable audience and
  optional exact `preservedText`. Complete input cannot be mixed with `correction`.
  The legacy `correction` request shape remains supported with version 1 semantics.
  The server supplies source actor/basis and provenance snapshots. `/retry` repeats
  captured input, not the current editor buffer. Acceptance rejects routing fields.
- New-policy generation, detail, retry, revision, discard (including replay) and discovery return the shared
  Stage review projection. Complete whisper, original provenance, initial direction
  and authoritative recipients are visible independently from performance.
  Pending/failed drafts do not display tentative recipients as model proposals.
- Unsaved complete-whisper/audience changes block Accept and ordinary Retry until
  applied through a replacement or explicitly cleared. Performance-only editing
  changes accepted text, never the captured generation input or delivery. Editor
  buffers survive switching candidates;
  pending-to-ready recovery initializes audience controls from the valid result.
  Terminal candidates with unsent edits remain recoverable by their original ID
  in Saved drafts, including while composing another turn. Terminal review exposes
  retained complete-whisper text/recipients and an explicit clear action; it never binds
  those edits to another candidate. These buffers remain session-local.

## #29 verification boundary

Regression coverage captures actual runtime prompt/context and recipient references,
repeated deletion through an empty whisper, unchanged subjective pre-turn state,
legacy hash interpretation, failed-candidate retry, explicit audience contradictions,
receipt export/import replay, lost/double actions, restart recovery, terminal edit
buffers and stale rejection. Browser and aggregate gate evidence is reported for
the actual worktree separately; fixture output is not live-model quality evidence.
Replacement derivation still requires a ready source artifact (or a discarded
ready source through the API). Failed/pending candidates support captured-input
retry; editing those directly requires a separate lifecycle extension. Unsaved
terminal edits remain copyable, never automatically rebound to another basis.

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
