# Picker-driven candidate routing (#16)

> Approved correction: [Actor Knowledge](ACTOR_KNOWLEDGE.md) supersedes older
> presence-derived observation and selective-context targets. All legitimate
> branch-relative knowledge is supplied upfront; outgoing recipients grant no
> observation. Legacy saved policies keep their exact interpretation.

This bounded contract follows the approved separation of observation/access from
tentative delivery. It does not implement notation grammar or historical revision.

## Version and observation boundary

Legacy text-only requests, saved drafts and receipts retain their original context
interpretation. Stage now explicitly selects `actor-knowledge-v1` with routing v3
and a required complete whisper. It supplies all legitimate branch-relative
knowledge, including active episode memories and superseded belief provenance,
without deriving observation from stored presence or outgoing recipients.

The legacy `audience-proposal-v1` policy (routing v1/v2) retains explicit active
presence observation, only when the acting identity is active. That interpretation
is frozen for compatibility, not the approved target for new Stage generation. Existing access links, beliefs,
memories and perceived transcript remain branch-relative. Delivery selections never grant surfaces or
dossiers, and do not change presence.

Proposal identities are supported pinned IDs referenced in actor-visible material,
legitimately recorded identities, and draft-local explicit director references.
Legacy policies also include their captured observed identities. A director may
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

Legacy complete-whisper replacement uses routing version 2; new-policy replacement
uses version 3. Both use `completeWhisper` (required, empty allowed) and an empty legacy `correction` field. Source/original identity, original
whisper snapshots and source artifact hashes remain immutable provenance; they
are not runtime input. Original snapshots still identify the pending whispers
consumed atomically on acceptance; the receipt's versioned routing captures the
complete replacement that actually generated the candidate. No schema migration
or rewriting of existing candidate/receipt hashes occurs.

Recipient eligibility is recomputed from actor-visible pre-turn material, the
complete whisper, and current explicit audience direction. Removed
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
perceptions and selected-whisper consumption. V3 derives no mutual first impressions
from recipients; existing branch-valid impressions remain historical knowledge.
Legacy acceptance retains its original first-impression derivation. Unaccepted
candidates have no canonical effects. Original candidates remain available.

## Compatibility and review

Receipt v2 routing metadata is self-contained in accepted receipts, including
source derivation; operational drafts remain outside exports. Old v1 receipt decoding
and historical context remain unchanged. Review exposes the candidate’s complete
whisper (or unresolved legacy input), original whisper provenance, initial direction,
final recipients and derivation, not raw context/prompt. Existing legacy
transport policy is not expanded; its broader minimization belongs to #17.

Stage whisper and Perform have independent prose and routing. Perform stays
immediate. New Stage manual submissions explicitly carry
`knowledgePolicy: "actor-knowledge-v1"`, preventing recipient-derived first
impressions. Old manual API commands without it retain their exact effects and
fingerprints; historical manual editing is unchanged. All explicitly selects pinned IDs and permits individual deselection.
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
- Stage posts `draftingPolicy: "actor-knowledge-v1"` and `completeWhisper` to
  `/drafts`; absent/null audience means unspecified direction. Legacy
  `audience-proposal-v1` and unversioned requests keep their prior behavior.
  Routing v3 requires prompt policy `actor-knowledge-v1` version `v1`; routing
  v1/v2 requires `audience-proposal-v1` version `v1`. Mismatches fail closed.
  Receipt v2 carries all three routing versions; no archive schema migration occurs.
- `/drafts/:id/revise` takes command ID, `completeWhisper`, nullable audience and
  optional exact `preservedText`. Complete input cannot be mixed with `correction`.
  The legacy `correction` request shape remains supported for legacy sources with
  version 1 semantics. V3 sources require complete-whisper revision and retain v3;
  retry repeats the saved version. Current Stage explicitly supplies
  `draftingPolicy: "actor-knowledge-v1"` when revising any saved source, so new
  complete-whisper replacements of v1/v2 sources use v3. Requests without opt-in
  retain prior API behavior. Reading, retrying or accepting the source never
  upgrades it. New hashes belong only to the replacement; original/source identity
  and artifact hashes remain provenance. Unknown policy or mixed additive input
  is rejected. Preserve-wording opt-in retains exact director-derived attribution,
  unchanged complete-input validation and empty tools, with no model call.
  The server supplies source actor/basis and provenance snapshots. `/retry` repeats
  captured input, not the current editor buffer. Acceptance rejects routing fields.
- Stage posts manual `knowledgePolicy: "actor-knowledge-v1"` to `/turns`.
  The immutable manual command binds that policy to its fingerprint and archive
  event validation. Unknown values fail closed; omission preserves legacy behavior.
  New-policy manual responses return the commit/turn outcome without raw context;
  old responses remain unchanged. The policy is not accepted for historical manual
  edit/regenerate commands in this slice.
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
