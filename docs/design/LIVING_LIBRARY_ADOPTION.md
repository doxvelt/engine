# Living Library adoption plan

Docs-only handoff based on `c400e2a`. The selected contract is
[Stage Experience](STAGE_EXPERIENCE.md), with
[visual guidance](../../design-system/README.md). The private study is an existing
reference, not a maintained frontend or required preview. The original handoff was
docs-only; the bounded collection implementation below updates LL-01 without closing its browser and accessibility gates.

These five stable slice IDs define independently reviewable delivery boundaries.
Each slice preserves immutable branches, subjective context, local/hosted domain
parity and the durable-operation guarantees in Stage Experience.

## LL-01 — Home, continuous transcript and accessible navigation

**Issue URL:** https://github.com/doxvelt/engine/issues/15.

**Baseline:** Home starts/resumes the database-backed example and offers workspace
creation/Studio routes plus browser-local recents. Stage has avatars, safe identity
popovers, draft review and conditional Jump to latest. Continuous transcript and
navigation adoption preceded this bounded collection slice.

**Target:** Featured return item with Continue, quieter collection, example plus
Create your own into Studio; continuous avatar-led script, quiet actions, compact
controls, stable reading position and resume caret at the draft end. No repeated
Accepted labels. Retain a clearly marked pending draft.

**Approved bounded collection slice:** Feature the most recently successfully
opened simulation, with opened runs ahead of unopened creation-time fallback and
stable simulation-ID ties. Continue opens its saved branch at the current head;
missing targets fail without source Start fallback. Installation-local navigation
is owner scoped, additive, separate from canonical history and excluded from archives.
Only successful intentional Stage entry records it; reads, polling, browser reload
and failed loads do not. Version conflicts/metadata failure warn without blocking play.
See [the exact collection contract](STAGE_EXPERIENCE.md#ll-01-collection-and-durable-resume).
Home retains example and Create your own/Studio in empty and populated states.
Workspace recents remain separate source shortcuts.

**Dependencies:** Agree token/specimen changes before
introducing new palette/type values. Historical Actor state remains gated by LL-04;
this slice keeps safe identity inspection. Visual transcript work can proceed
independently of the collection decision.

**Acceptance checks:** First arrival and populated return expose example and
Studio entry without interpreting a metaphor. Resume preserves pinned content and
creates no turns or drafts. Check opening, long history, pending/failure and narrow
layouts at the Stage contract's four viewports; keyboard navigation, focus return,
contrast, touch reachability and overflow remain usable. Reading earlier history
survives updates; Jump appears only off the latest edge. Repeated resume adds no
newlines; ordinary edits/picker changes retain selection. Validate phone keyboard
and assistive-technology behavior separately from scripted browser checks.

**Exclusions:** Run management, new examples, Studio authoring redesign, domain
renames, full branch trees, new dependencies and copied study assets. Spacing
polish follows structural adoption; no alternative transcript comparison is needed.

## LL-02 — Composer routing and proposed-audience draft contract

**Issue URL:** https://github.com/doxvelt/engine/issues/16.

**Bounded implementation:** The picker-driven candidate contract is documented in
[Composer Routing](COMPOSER_ROUTING.md). New Stage requests use a fixed actor,
tentative or unspecified initial recipients, validated proposals and explicit
director corrections through new candidates. Observation comes from branch-bound
presence, independently of delivery. Director-preserved wording is an explicit
derived artifact. Legacy text-only drafts retain their original interpretation.
Notation grammar/roundtrip and device/accessibility acceptance remain open; this
implementation does not close LL-02. Bounded automated browser evidence and
independent aggregate gate results accompany the implementation PR.

**Baseline:** Direct/Perform preserve separate prose; explicit picker IDs capture
actor/audience before generation. Manual Perform commits immediately. Generated
acceptance can edit text but cannot rebind actor/audience. No routing parser ships.

**Target:** Stage whisper/Perform vocabulary; optional synchronized #actor/@audience
and pickers, arbitrary subsets and All as concrete cast selection. Keep Original
stage whisper distinct from the draft performance. Permit private natural-language
direction to request a draft with a proposed audience for explicit review.

**Dependencies:** Specify whisper-versus-output routing scope and validation before
parsing either. Define the engine/application/API revised-candidate lifecycle,
provenance, actor-context and staged-effect revalidation for routing corrections,
including actor changes. Establish audience-proposal behavior without relying on
fixture inference or blank input defaults. UI orchestration uses shared contracts.

**Acceptance checks:** Picker/notation changes round-trip without losing prose,
line breaks, undo or independent mode state. Whole-turn recipient unions deduplicate
and retain recipients with remaining occurrences. Unknown IDs/multiple actors fail
without public fallback. All expands pinned supported IDs and allows deselection;
sender-own perception persists. Plain names never route. Verify separately who
receives a private whisper and who perceives the accepted output, including an
instruction about a third person and explicit @ notation in a whisper. Model
proposals/corrections require visible review and server validation; accept never
rebinds a fixed candidate. Rejected, failed and retried proposals leak no effects.
Preserve restart discovery, candidate identity and idempotency through corrections.

**Exclusions:** New audience aliases/defaults, passage-level delivery, automatic
model turns, unrestricted tools, and mandatory manual preview. Preserve immediate
manual Perform until its own decision. Fixed study replies prove no live inference.

## LL-03 — Historical revision, provenance and durable operations

**Issue URL:** https://github.com/doxvelt/engine/issues/17.

**Baseline:** The engine supports immutable alternate history and pure head-relative
context; Stage supports continuation drafts and durable retry, not historical
revision controls. Discovery is filtered server-side through `stageDraft`, but
generation/retry and draft-detail HTTP responses carry full records with whisper
text, context and prompt. The Stage client filters those responses after receipt;
its view/type does not redact transport payloads. Saved candidates
survive API restart; local unsaved edits survive refresh with navigation warnings.

**Target:** One inline historical editor; hide/preserve the continuation composer
and its candidate. Edit performance, regenerate the selected turn's own whisper,
or edit that whisper against pre-turn context. Preserve original path/candidate;
accept an alternative containing the prefix and replacement, excluding descendants.

**Dependencies:** Map existing branch operations into durable historical commands
and shared UI contracts. Specify and verify transport minimization separately
from client-view filtering; provide authorized originating-whisper/provenance
retrieval without widening discovery or assuming existing detail/retry payloads
are redacted. Use LL-02 for revised candidate routing;
fixed-route revision can be bounded separately. Specify recovery of inline edits
and suspended continuation state without claiming current all-input autosave.

**Acceptance checks:** Select an older turn after unrelated later whispers; regenerate
only its own input at its parent head. Manual/missing-provenance cases offer explicit
new direction. Cancel restores the continuation without changing history. Alternative
acceptance leaves original descendants intact and excludes their perceptions, memory
operations and closures from the new path. A preserved candidate returns only to its
original basis. Exercise ready/failed/in-progress recovery after reload/API restart,
lost responses, stale heads, multiple candidates, double actions, failed projection
refresh and late responses after scope changes. Unsaved wording survives refresh
and terminal changes; no duplicate commits or effects escape rejected candidates.
Verify actual generation, retry, detail and discovery HTTP payloads against the
decided disclosure policy, not only the client view or TypeScript types.

**Exclusions:** Full branch-tree UI, rewriting accepted history, retaining incompatible
descendants, invented whisper provenance, a new memory engine and model auto-turns.

## LL-04 — Authorized historical Actor state

**Issue URL:** https://github.com/doxvelt/engine/issues/18.

**Baseline:** Stage exposes safe public identity. Core actor context is a pure
projection, but that alone does not authorize disclosure in the player UI.

**Target:** Actor state from avatar/name at the relevant historical turn, with
available runtime fields and provenance; composer inspection uses its draft basis.

**Dependencies:** Decide owner/access policy, allowed fields and temporal query
contract. Before by default/After comparison remains a proposed treatment. LL-03
provides historical editing integration; read-only turn inspection can proceed
independently. Do not bypass the safe identity contract while this policy is open.

**Acceptance checks:** Inspect an older turn after later state changes and an
alternate branch: show authorized state at the labeled boundary with provenance
and honest unavailable fields. Cross-owner and unauthorized access fail without
leaking beliefs, memories, whispers or prompts; a player-visible projection never
grants the information to another actor. Reads create no state. No invented model
reasoning. Keyboard entry/exit restores focus to the originating identity.

**Exclusions:** Omniscient inspection, fabricated goals, raw context dumps, new
memory systems and player briefing authoring (LL-05).

## LL-05 — Player briefing content and projection

**Issue URL:** https://github.com/doxvelt/engine/issues/19.

**Baseline:** Empty Stage displays pinned scenario identity; ordinary actor turns
create the opening. There is no approved briefing source or visibility contract.

**Target:** Enough world/scenario-specific orientation for a meaningful first turn,
separate from accepted history and actor knowledge. A short authored briefing,
reopenable through scene identity, is the proposed presentation.

**Dependencies:** Decide authorship, player visibility, revision pinning and source
projection. Preserve identity-only orientation until that contract is accepted.
Independent of LL-04; neither requires a new memory engine.

**Acceptance checks:** Player-visible text follows its explicit pinned revision
when source content changes. Hidden canonical material is not exposed merely by
loading Stage. Showing/reopening a briefing creates no turn, perception or actor
knowledge. The ordinary first performance remains in history, with any supported
actor including stateless actors; no mandatory narrator. Verify opening layout and
keyboard access alongside the actual composer, not a second setup form.

**Exclusions:** Raw scenario dumps, synthetic accepted openings, implicit
omniscience, new examples and broad authoring redesign.

## Delivery checks

Each implementation issue should report focused behavior tests for changed seams
and final repository `check` and `ui:build` results with Node >=24. Keep deterministic
runtime integration, live model quality, browser interaction and accessibility
evidence distinct. Preserve supported stateless actors and ordinary opening turns.

For this docs-only handoff: check local Markdown links, `git diff --check`, changed
file scope and private-reference leakage. No production test results are claimed.
