# Historical revision (#17)

This is a bounded implementation contract for LL-03, refreshed against main at
`7683385bbfb5be514103031b6f1a2a624ae51b6e` (merged PR #30, implementing #29
complete-whisper replacement on #27 Composer Routing). It specifies work to
implement, not shipped historical controls, autosave, endpoints or test coverage. [Stage Experience](STAGE_EXPERIENCE.md#historical-revision)
remains binding; the [Living Library adoption plan](LIVING_LIBRARY_ADOPTION.md#ll-03--historical-revision-provenance-and-durable-operations)
owns delivery gates. [Composer Routing](COMPOSER_ROUTING.md) governs candidate
replacement and legacy compatibility. This document adds no separate status board.

The approved disclosure policy permits the owner/director to retrieve the exact
recorded whisper provenance through a dedicated owner-scoped response, without
raw prompt, actor context or unrelated whispers. Unsaved inline edits and suspended continuation
state must survive browser close/reopen through browser-local autosave. Saved
candidates remain server durable. Browser buffers have no cross-device sync.

## Shipped seams and the gap

| Seam | Main baseline and implication |
| --- | --- |
| [Branch kernel](../../src/core/branch-kernel.ts) | `editAcceptedMessage` and `regenerateAcceptedResponse` both take manual text, retain the original actor/logical message identity, create a new version at the selected commit's parent and validate the source branch's expected head. Neither invokes a model. Root/non-message/off-path selections are invalid. |
| [Draft lifecycle](../../src/core/draft-lifecycle.ts) and [contracts](../../src/core/ports.ts) | Generation reserves a durable candidate before runtime execution; its branch must currently be at its basis head. Exact command replay returns the existing record without generation. Retry is a distinct candidate. There is no historical-operation contract binding a candidate to a selected accepted turn. |
| [Candidate routing](../../src/core/candidate-routing.ts) | `projectRoutingContext` uses only `completeWhisper` for version 2 private direction and excludes source artifacts from prompt/context. Recipient references are recomputed; explicit corrected audience supersedes tentative initial direction. `completeWhisperForDraft` reports legacy additive/multiple-input origins as unresolved. Version 1 and captured retry retain their frozen interpretation. |
| [Acceptance](../../src/core/draft-acceptance.ts) | Ready drafts are revalidated against their frozen context, selected whispers and routing. Acceptance appends to the draft's current branch, with generated/acceptor-edited/director-preserved attribution. It does not create a historical sibling or retain a replaced message's logical identity. |
| [SQLite adapter](../../src/store/branch-sqlite.ts) | Manual sibling creation is atomic. Generated acceptance atomically writes the commit, head, terminal draft and command receipt. These are separate operations today; composing them as separate client calls does not establish atomic historical acceptance. |
| [API](../../src/local-api/server.ts) and [Stage transport](../../src/local-api/stage-contracts.ts) | `/edit` and `/regenerate` accept `manualText`. Routed generation, retry, detail, revise and discard responses use `stageDraft`; legacy generation/retry/detail/discard still return full draft records. Discovery always uses `stageDraft`, whose routed review separates complete whisper (or unresolved legacy input), original whisper provenance, legacy correction and audience/derivation metadata. Acceptance currently returns branch/commit data, not a minimized historical outcome. Client filtering is not transport redaction. |
| [Stage session](../../src/local-ui/lib/stage-session.ts) and [command leases](../../src/local-ui/lib/stage-play.ts) | Buffers, retained terminal reviews and leases are in memory. Refresh within a session preserves edits; navigation warnings are not close/reopen autosave. Sessions guard API/simulation/branch changes and hold mutation identity through projection convergence. |

Draft discovery is owner/simulation/branch scoped, ordered by creation time and ID,
and includes generating, ready and failed records even when stale. Accepted and
discarded records leave that list but remain retrievable by ID. A stranded
`generating` record after restart does not prove a worker is still running.
Operational drafts are excluded from logical archives; accepted receipts retain
provenance and replay identity independently of draft rows. Preserve those
boundaries, legacy interpretation and versioned receipt validation.

## Interaction and temporal basis

Keep one inline editor at the selected historical turn. Hide and preserve the
continuation composer, both mode buffers and routing, selected candidate, wording
and corrections. A waiting continuation must converge or be explicitly cancelled
before conflicting historical work starts. Closing the editor is not proof that a
request or runtime was cancelled. Cancel restores the suspended continuation;
it never edits accepted history or silently discards its candidate.

Resolve the selected turn by commit and message-version identity, not transcript
index, text or actor name. Retain these distinct boundaries:

- **Source branch/head:** the branch and expected current head from which the
  director selected the turn; this is the concurrency guard.
- **Selected turn:** its immutable commit, message version, logical message and
  actor, validated as belonging to that source path.
- **Parent basis:** the selected commit's immediate parent, including all ancestor
  events, not merely the previous visible message. This is the replacement's
  context and causal parent, including when replacing the first turn after root.

The server resolves and verifies that relationship under owner/simulation scope.
Use the simulation's pinned content and pure actor projection at the parent.
Never use the latest head, the selected turn's after-state, later whispers or a
continuation candidate's context. No new perception, memory, first impression,
closure or whisper consumption occurs from opening, inspecting or generating.

The current expected-head guard still applies to the source branch. A changed
source head is a conflict even if the selected immutable turn remains an ancestor.
Keep the candidate and local edits available; no automatic rebase or retargeting.
An exact already-applied command replays before stale-head rejection. Any renewed
request after conflict must explicitly capture a validated source selection and
new command identity; it must not rewrite a saved candidate's basis.

## Historical actions and provenance

| Action | Required behavior |
| --- | --- |
| Edit performance | Begin with the selected accepted wording and concrete recipients. Retain its actor. Submitting the manual edit creates an alternative, with manual edit attribution and no model call; typing remains browser-local. This does not introduce a general manual-preview or server-saved manual-candidate feature, and ordinary Perform stays immediate. |
| Regenerate originating whisper | Resolve the selected turn's latest recorded complete whisper, including deliberate empty direction, and generate at the parent basis. Show exact original provenance separately from the complete generation input, proposed performance and final recipients. If no complete whisper is recoverable, require explicit replacement. Generation itself accepts nothing. |
| Edit originating whisper | Open the latest recoverable complete version, keeping original provenance immutable. Store the director's complete replacement as distinct input with derivation back to the selected turn; unresolved legacy input requires explicit replacement. Generate at the same parent and review before acceptance. |
| No originating whisper | Say whether none was recorded or provenance is unavailable. Offer manual editing or explicit new direction. New direction is new input, never a claimed recovered whisper or a retry of an unknown prompt. |

An accepted turn may be manual with no whisper, generated without direction, or
imported with accepted provenance but no operational candidate. Do not equate an
absent draft row with absent accepted provenance. Resolve accepted receipts and
the selected commit's whisper-consumption events where present; check their
identity and consistency. Hashes cannot reconstruct missing text. A manual turn
can also have explicitly recorded direction; expose what the record establishes,
without labeling it model generation. Conflicting or insufficient provenance is
unavailable, not permission to infer from adjacent turns or prose.

The approved phrase **exact originating whisper** means recorded input, not
keystrokes before API normalization. Display exact available provenance separately
from the complete whisper that will generate the replacement. For accepted routing
version 2, use the receipt's `completeWhisper`, even when empty; original consumed
whisper snapshots remain provenance, not an instruction to replay. An uncorrected
single-input origin can supply its recorded complete text; a recorded no-direction
origin supplies empty input. Missing evidence is not evidence of empty direction.

Legacy additive or multiple-input origins have no recoverable complete whisper.
Retain the exact available records, identities/order where established and legacy
correction provenance for review. Require explicitly entered complete replacement
or deliberate confirmation of an empty replacement. Never concatenate, summarize,
select one of several inputs, or infer a complete whisper from accepted wording.
A new historical generation follows complete-whisper semantics even when its
source is legacy; it does not migrate the source record or retry its old recipe.

Every new historical generation receives only the latest complete whisper plus
the original actor's subjective pre-turn context, with the current routing contract.
Never include earlier whispers, additive correction feedback, the selected accepted
performance, source performance or prior attempts in generation input. Source and
derivation identities/artifacts remain provenance outside the model request. The
pre-turn projection still contains legitimate actor-visible ancestor history; this
exclusion concerns the selected turn and replacement attempts, not that history.
Generation semantics are resolved, not a remaining product decision.

Reading original direction does not make it canonical truth, actor memory or a
message to its recipients. Historical generation binds the selected input to the
new operation. It cannot reuse an old pending-whisper ID as if it were staged on
a different branch/head, consume unrelated pending direction, or undo consumption
on the original path. Consumption for the replacement belongs only to its accepted
path and identifies the exact new input plus its source provenance.

## Durable historical operation

Use a durable application-level identity linking the historical intent, candidates
and eventual outcome. A browser pointer or a guessed branch name is insufficient.
This section specifies required information and transitions, not tables, route
names or a wire schema.

A submitted historical operation must retain owner/simulation scope, source
branch and guarded head, selected commit/message version/logical identity, parent
basis, pinned content, actor, action kind and exact submitted input. Retain origin
provenance or its explicit absence, routing/policy interpretation, candidate and
immediate-source identities, and command/outcome identities. Generated artifacts
retain runtime, prompt/context, skill and capability provenance server-side under
the existing contracts. Do not synthesize model provenance for a manual edit.

The browser reserves and autosaves stable command identity and submitted input
before sending. The server binds identity to a canonical request fingerprint.
Reusing it for changed wording, routing, scope, action or basis conflicts; an exact
replay returns the same durable result. A retry or correction is a deliberate new
command/candidate linked to the historical operation, not replay of generation.

| Lifecycle boundary | Required durable/recovery behavior |
| --- | --- |
| Local editing, not submitted | Autosave editor and suspended continuation. Do not imply server durability or start runtime work. |
| Submitted generation | Reserve operation/candidate identity before invoking runtime. Recover generating, ready or failed results by identity and scoped discovery, even if the first response never reached the browser. |
| Submitted manual edit | Bind the exact edit command and resulting alternative atomically. Lost response recovery must find/replay that outcome without committing again. |
| Ready review | Candidate is immutable in basis/input/artifact. Local wording changes stay distinguishable. Retry and corrections preserve earlier candidates and their derivation. |
| Failed/interrupted generation | Keep a safe failure or honest in-progress state. Explicit retry creates a new candidate; replay does not silently restart runtime execution. Discard can settle stranded work without canonical effects. |
| Accepting/discarding, outcome unknown | Keep the command and submitted payload leased across browser/API restart. Query/replay the same identity before allowing a conflicting action; never infer failure from transport loss. |
| Accepted/discarded | Terminal transition cannot be reversed by late runtime output. Acceptance outcome identifies the alternative branch/commit; discard adds no canonical history. Retain lookup/replay even though terminal candidates leave pending discovery. |

Historical discovery must distinguish operations by selected turn and parent from
ordinary continuation drafts, with deterministic ordering and selectable candidate
identity. It must not require a surviving browser cache. Detail/outcome lookup must
support terminal reconciliation. Merely extending today's pending-only list is
insufficient for lost acceptance responses. Saved operation/candidate recovery is
server durable; unsubmitted browser wording remains local.

Editor cancellation suspends the UI workflow; explicit candidate discard is a
separate durable action. Neither removes the original accepted path, the originating
candidate, sibling candidates or the suspended continuation candidate. Race handling
must produce one terminal outcome for a given candidate and acceptance identity.
How one operation exposes subsequent acceptance of another sibling candidate is
not settled here; do not implement automatic group discard or bulk acceptance.

## Candidate correction routing

Apply #30's complete-whisper [candidate contract](COMPOSER_ROUTING.md#candidate-lifecycle), not a
second historical routing system. One fixed actor owns the selected turn and its
replacement. Both current historical kernel operations require the original actor;
#27's fresh-operation rule for changing actors does not authorize replacing a
historical turn with another actor in #17.

For new-policy generated candidates, delivery remains distinct from observation.
Presence, access, perceptions and memories come from the parent projection.
Tentative/unspecified initial recipients are not model proposals. Review exact
performance and validated concrete recipients; retain sender-own perception,
supported pinned IDs and failure without an All/public fallback.

Complete-whisper or audience changes produce distinct durable candidates at the
same historical basis. Capture latest complete input and current audience direction;
retain original identity and immediate-source artifact only as derivation provenance.
Recompute implicit recipient references from actor-visible pre-turn material,
observed presence and current complete input. Deleted mentions and source artifacts
grant no references. Preserve explicit audience decisions when prose changes.
An explicit replacement audience is authoritative and supersedes initial tentative
direction; contradictory output fails. An explicit request for a fresh proposal
uses the existing nullable-audience contract, not a silent reset from prose deletion.
Chained generations open the latest complete version, including empty text, and
never accumulate earlier direction or performance as model input.

Preserve-wording correction uses the exact editor wording, reruns context/routing
validation and attributes the new artifact to the director; it makes no model call
and remains supported only with an empty capability grant and unchanged, resolved
complete whisper. Changed or unresolved whisper input requires generation.
Retry uses the saved candidate's captured input and policy, not current editor
fields; verify its matching prompt/context hashes. Exact replay returns the saved
record without a runtime call. Legacy retry preserves additive/source-material
interpretation exactly, including older corrections that never included source
performance. Neither accepting nor retrying a legacy candidate upgrades it.
Unapplied whisper/audience changes block Accept and ordinary Retry until applied
or explicitly cleared. Buffers remain associated with their own candidate,
including terminals. Text-only acceptor edits remain distinct from routing changes
and retain attribution. Acceptance never changes actor, recipients, parent or
source selection.

Do not pass an accepted original candidate to today's `/revise`: its source contract
requires a ready/discarded routed draft, not an accepted turn. Historical provenance
resolution and candidate creation are a new application seam. Legacy drafts and
receipts retain their frozen prompt/context interpretation; #17 does not silently
convert them to the proposal policy or relabel accepted material as unaccepted.

## Owner-scoped disclosure and transport minimization

Authorization is server-side on every query/mutation, including replay. The local
API currently derives the `local` owner and rejects caller-supplied owner scope;
that is not hosted authentication. Preserve explicit owner contracts without
building new accounts or treating knowledge of an ID as authorization.

The dedicated historical provenance response must bind the requested source
branch/selected commit/message version and actor to the authorized simulation.
Return only the exact available originating whisper record(s), recorded complete
replacement and correction provenance where present, their source association,
an honest availability result, and minimal derivation labels needed to distinguish
original direction from correction/new direction. It must work from accepted
provenance without requiring operational drafts. No raw prompt, actor context,
hidden state, provider diagnostic trace or unrelated whisper crosses this response.
Unavailable and unauthorized are not a fallback to a broader inspection endpoint.

| Response surface | Required disclosure boundary |
| --- | --- |
| Generation and retry, including replay | Server-projected operation/candidate identity, basis, status, performance, reviewed routing and safe provenance/failure. Preserve #30's authorized candidate-specific complete-input/legacy-provenance review. No full draft record, raw context/prompt or unrelated whisper; apply to legacy as well as routed results. |
| Candidate detail, including terminal lookup | The same bounded review projection, plus outcome references needed for reconciliation. Requesting detail is not permission to dump frozen runtime inputs. Historical originating-input retrieval uses the dedicated authorized response. |
| Discovery | Scoped recoverable operation/candidate review with deterministic identity/order. Do not widen the existing candidate-specific review to bulk historical whispers, raw receipts, contexts or prompts. Terminal outcome recovery must not expand list disclosure. |
| Correction, discard and acceptance, including replay | Bounded review or outcome references needed to converge. Do not bypass minimization through nested source artifacts, raw commit events, error bodies or replay envelopes. |

Keep #30's candidate complete-whisper/original-provenance review distinct from newly
authorized retrieval of an **accepted historical turn's** originating input.
The latter is not authorization for omniscient Actor state (#18), raw `/context`
inspection, unrelated transcript direction or wholesale receipt serialization.
Server projection must enforce the allowlist before serialization, including
legacy paths; changing TypeScript types or filtering after fetch cannot satisfy it.
Inspect actual serialized success, failure and replay payloads. This contract does
not claim all other existing inspection/export APIs have been redesigned.

## Effects and atomic alternative acceptance

An accepted alternative consists of the shared prefix through the parent and one
replacement commit. Retain the logical message identity and give the replacement
a new immutable version. Leave the original selected commit, descendants, branch
head, originating candidate and suspended continuation unchanged. Exclude the
selected turn's old effects as well as descendants' perceptions, first impressions,
audience/access events, beliefs, memory operations and closures. Ancestor state
still applies. Late memory results remain attached to their original closure.

Recompute replacement perceptions and first impressions against the parent and
reviewed delivery. Never copy old turn events, random results, capability effects
or memory outcomes onto new wording. Current runtime/correction contracts have an
empty capability grant. #17 does not enable tools or a new effects engine; see the
unresolved policy for editing existing effectful manual turns below.

Historical generated acceptance must validate scope, source ancestry/expected head,
selected identity, parent, pinned content, candidate readiness, provenance, exact
input and final routing in the committing transaction. Atomically bind the new
alternative branch, replacement commit and its effects/consumption, terminal
candidate transition, operation outcome and idempotent receipt. A rollback leaves
no partial alternative, consumed input or terminal candidate. Manual acceptance
must meet the equivalent applicable boundary without fabricating a generated draft.

Do not use client-side fork-then-generate-then-append as proof of this guarantee,
or mutate a draft's branch/basis to fit the current acceptance endpoint. Any
internal preparation is noncanonical and must not leave a playable empty
alternative on failure/cancel. Store/receipt evolution must preserve original
accepted replay and portable history without operational draft rows. Browser
buffers and suspended UI state are not portable canonical archive contents.

After acceptance, navigate only once the exact outcome and replacement projection
converge. A failed projection refresh leaves a recoverable accepted outcome, not
an invitation to submit a second acceptance. Return to the preserved continuation
restores its original branch/basis; if that branch advanced independently, show it
as stale. Never offer it against the alternative or silently regenerate it there.

## Browser-local recovery

Autosave must cover the active historical selection/action, unsaved performance
and whisper wording, per-candidate wording/corrections/routing, selected candidate,
both suspended continuation mode buffers/routing and their original branch/head.
Persist unresolved command IDs and exact submitted payloads separately from newer
editor changes, along with enough workflow state to reconcile on reopen. Saving a
buffer does not upload it as a candidate or mutate canonical history.

Scope storage to browser origin/profile, API installation and effective owner,
simulation, branch and historical operation/selected version or candidate identity.
An API URL alone must not restore private text into a replaced database or another
owner. Validate scope and record version before applying a cache; where installation
identity cannot yet be established, require resolution rather than automatic reuse.
Never store credentials, raw prompts/contexts or unrelated whispers. Only retain
direction authorized and needed for the resumed editor, not a historical whisper
cache. The installation-identity mechanism is an implementer choice under these constraints.

On reopen, load the server projection, discover saved work and reconcile known
terminal/outstanding identities before enabling dependent mutations. Restore local
wording as an overlay, not as the saved artifact or a newer canonical state. Match
by full scope and IDs, never by newest timestamp, list position or similar text.
Preserve dirty wording when a candidate becomes accepted/discarded elsewhere;
mark it unsubmitted and tied to its original candidate, with explicit clear action.
Never resurrect a terminal candidate or apply its edits to another one.

Autosave must write during editing and at workflow boundaries, not rely on an
unload handler. Report saved locally only after storage success; flush/check
suspended state before hiding the continuation. Quota, denied storage, corrupt or
unsupported records and failed writes require a visible recovery warning, retained
in-memory text and a way to copy it out. Do not falsely promise reopen recovery or
silently delete other buffers to make room. If unresolved mutation identity cannot
be persisted, do not start a dependent conflicting mutation under an apparent
durability guarantee. Existing server candidates remain discoverable independently.

Browser storage is fallible: clearing/eviction or another device can lose unsent
text. State this limit without treating it as permission to omit close/reopen
autosave. There is no server backup or cross-device sync of these buffers. Cache
cleanup must not erase dirty or unresolved work on refresh, navigation or terminal
transition; explicit clear removes only its identified local buffer.

Concurrent tabs must detect conflicting buffer revisions and retain both texts
for explicit resolution; silent last-writer-wins replacement is unacceptable.
Resolve against server status before acting, since browser conflict resolution
cannot override expected-head checks or terminal outcomes. Automatic merging of
prose, routing or pending commands is not authorized.

Guard every async result and autosave write by scope, operation/candidate,
selection generation and editor revision. A late provenance/generation/retry/detail
response must not replace newer typing, steal selection, reopen a cancelled editor,
switch branches or overwrite another scope's cache. A response can reconcile its
own known operation without making it the current editor. Discard/accept races
settle server-side; late runtime completion cannot revive a terminal record.

## Decisions still required before dependent implementation

- **Effectful selected turns:** the kernel can commit manual audience/access
  changes alongside text, but Stage has no approved historical review policy for
  replacing those effects. Define that policy before enabling such revisions;
  block unsupported cases explicitly rather than copying or silently dropping
  non-message effects. Tools and effectful preserve-wording corrections stay out
  of scope.
- **Multiple accepted alternatives per operation:** define whether choosing another
  retained candidate after one acceptance needs a new linked operation or another
  explicit acceptance within the same workflow. Preserve all candidates meanwhile;
  no automatic disposal or acceptance follows from the first selection.

These are the remaining product gates for their dependent cases. They do not reopen
the approved complete-whisper generation, owner/director disclosure or browser-local
autosave decisions. Recovery identity, storage/versioning and tab-conflict detection,
operational retention/discovery, endpoint names, archive-version evolution and UI
decomposition are implementer choices under this contract, not additional product
approval questionnaires. Preserve accepted receipt replay; no automatic expiration
of unsaved work or new portable operational-draft semantics is authorized.

## Delivery sequence

Follow #25's sequencing: review and merge this docs-only contract first. Deliver
engine/API in a separate PR covering transactional historical operations, scoped
provenance, minimized transport and portable accepted-history/replay proofs.
Validate and merge that engine base before a separate UI/recovery PR implements
inline revision and browser-local close/reopen recovery. Each implementation PR
requires independent review and human merge. No UI implementation belongs in the
engine/API PR, and no partial delivery automatically closes #17. This adds no
maintained dependency or parallel system and changes none of #18, #19 or #28 scope.

## Acceptance matrix

These are required future implementation checks, not tests added or executed by
this document. Exercise the relevant kernel/application, transactional store,
actual serialized API and browser boundaries separately.

| Scenario | Required observation |
| --- | --- |
| Older turn selected after unrelated later whispers | Latest complete input for the selected turn only; generation uses its immediate parent, pinned content and original actor. Unrelated later context/direction never enters the candidate. |
| First turn, non-message/root, off-path or forged selection | First turn uses root as parent; invalid selection fails without draft, branch or leaked provenance. |
| Manual edit and generated replacement | Manual path makes no model call; model path stays unaccepted until review. Both preserve original actor/logical identity and create a new version; no misattributed model wording. |
| Manual/no-direction/imported/missing or conflicting provenance | Explicit none/unavailable state; accepted provenance works without draft rows where available; new direction is labeled new and no whisper is inferred. |
| Corrected/legacy/multiple-input origin | Use recorded complete input where available; otherwise require explicit complete replacement, including deliberate empty. Display exact available provenance separately; saved legacy retry/acceptance retain frozen hashes and interpretation. |
| Delete instruction/mention across repeated historical generations, then empty whisper | Capture the actual `runActorTurn` request (prompt and context), not just editor state or fixture output. A unique deleted instruction such as “elephant”, removed implicit recipient references, earlier whispers, additive feedback and accepted/source/prior-attempt performance must be absent; legitimate pre-turn context and explicit audience decisions remain. Repeat through deliberate empty input and retry. |
| Owner mismatch and transport policy | Unauthorized reads fail; generation, retry, detail, discovery, correction, discard, acceptance and replays contain only authorized projections, including legacy candidates, nested data and failures. Dedicated origin response contains no raw context/prompt or unrelated whisper. |
| Audience correction chain and preserve wording | New identities at the same parent; immediate source and original derivation retained outside model input; implicit references recomputed, explicit audience preserved, invalid output fails. Preserve wording invokes no model and cannot apply changed/unresolved whisper; acceptance cannot retag. |
| Unapplied corrections, candidate/mode switching | Accept/ordinary Retry blocked until applied or cleared; independent wording/routing and candidate-specific buffers survive switching and terminal transitions. |
| Alternative with downstream access, perceptions, memory and closure | New path contains prefix plus replacement only; old effects/descendants remain on the original. Ancestor memories remain valid; late old closure work never attaches to the replacement. |
| Rollback and concurrent accept/discard | All acceptance writes roll back together; one terminal winner, no partial branch, duplicate receipt/commit or leaked effects. Unsupported effectful originals fail explicitly. |
| Cancel and return to continuation | Restore both composer modes and candidate on its original branch/basis, preserving focus/reading position. Independently advanced basis is stale, never rebound to the alternative. |
| Browser close/reopen and API restart | Inline/suspended local buffers recover in the same browser scope; ready/failed/in-progress server candidates and historical associations recover without browser pointers. No claim that stranded runtime work resumed. |
| Lost generation/correction/manual-edit/accept/discard response | Reconcile the saved command identity and exact payload, including terminal outcome absent from pending discovery; no automatic new model call or duplicate alternative. |
| Mutation succeeds but projection fails | Keep accepted result and lease until matching projection converges; retry fetch/replay, not a new acceptance. |
| Source head advances; double click; changed payload under same ID | Conflict or exact replay as appropriate; preserve local work, never silently rebase. Distinguish source concurrency head from parent context. |
| Storage quota/denial/corruption/eviction and conflicting tabs | Honest unsaved/recovery state, no silent overwrite, copy-out available, server drafts recover independently; tab conflicts retain both buffers for explicit resolution. |
| API/database/owner/simulation/branch/selection changes with late responses | No cross-scope text disclosure, stale cache write, selection theft or terminal resurrection; newer typing is preserved. |
| Portability | Accepted alternative/provenance and receipt replay survive logical export/import without operational drafts; browser state is not exported as canonical truth. |
| Inline interaction | Single editor, hidden preserved composer, discoverable keyboard/touch actions and focus return; verify Stage's four target viewports and distinguish scripted checks from real device/assistive-technology validation. |

Future implementation validation must report actual coverage and remaining gates
under the adoption plan. This docs-only change requires relative-link validation,
`git diff --check` and changed-file scope review; it does not claim runtime, browser,
accessibility, build or production tests passed.
