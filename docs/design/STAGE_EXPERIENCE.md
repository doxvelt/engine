# Stage Experience

> Approved correction: [Actor Knowledge](ACTOR_KNOWLEDGE.md) supersedes older
> presence-derived observation and selective-context targets. All legitimate
> branch-relative knowledge is supplied upfront; outgoing recipients grant no
> observation. Legacy saved policies keep their exact interpretation.
> For future historical regeneration, validated generation and safe commit
> create/select an alternative immediately, with no separate Accept UI. Alternatives
> cycle at the branching turn and preserve their continuations. Older historical
> draft/Accept and sibling-acceptance gates below are superseded; ordinary
> continuation Accept and manual editing are unchanged. Blanket effectful-turn
> blocking was a recommendation, not approved policy; unsupported cases stay gated.
> Sequence: #32 context, then #17 saved alternatives engine/API, then UI recovery
> and cycling. Cleanup #33 remains separate with semantics undecided.

**Status:** Living Library + **Continuous script** is the selected interaction
and visual direction. This contract separates that target from the implemented
baseline at `7683385bbfb5be514103031b6f1a2a624ae51b6e` (merged PR #30).
It supersedes earlier Stage study hypotheses; selection of
a direction does not approve every prototype behavior. See the
[adoption plan](LIVING_LIBRARY_ADOPTION.md) for dependency gates and acceptance checks,
and the [design system](../../design-system/README.md) for visual treatment.

## Implemented baseline

The existing Nuxt/Nuxt UI Stage uses shared
[transport types](../../src/local-api/stage-contracts.ts) and a focused
[session client](../../src/local-ui/lib/stage-session.ts):

- One conversation surface serves opening, history and generated draft review,
  with a compact header, scrolling history and reachable composer/review actions.
- **Stage whisper / Perform** have independent prose and routing buffers.
  Stage whisper generates a durable Pi candidate for a fixed actor, with tentative
  or unspecified initial recipients and a validated audience proposal.
  **Perform immediately commits** manual prose through the supported turn API; there is no manual preview lifecycle.
- Actor and Audience pickers send explicit supported IDs from the pinned cast.
  The current **All** picker expands that cast; it does not change the persistent
  presence roster or supply an unrestricted API alias. The sender perceives its
  own turn. Invalid IDs fail without widening delivery. No input routing parser ships.
- Generated performances are read-first drafts with Edit, Retry, Accept and
  Discard. Actor and audience are captured at generation and cannot be rebound
  at acceptance. Retry creates a distinct durable candidate with the captured
  basis, actor, routing policy and private input; the earlier draft stays reachable.
- Saved drafts are discovered through owner/simulation/branch-scoped repository
  reads, including after lost responses, browser reload and API restart. Stale
  bases and failed/in-progress records remain visible; terminal records leave
  pending discovery. Multiple candidates have deterministic ordering.
- Refresh preserves unsaved review wording, including when another session makes
  the selected record terminal. Saved artifact text is distinguished from local
  edits, with navigation warnings. This is not browser-reload autosave of all input.
- Opening orientation is **pinned scenario identity only** plus a neutral invitation.
  Identity inspection exposes safe public identity (currently name, kind and ID),
  not subjective context. Discovery uses `stageDraft` server-side for all candidates.
  Routed generation/retry/detail/revision/discard also use that projection, including
  complete-whisper and candidate-specific provenance review. Legacy unrouted
  generation/retry/detail/discard still return full records with whispers, context
  and prompt; client filtering is not HTTP redaction. Acceptance returns branch/commit
  data. Historical transport minimization and authorized accepted-input retrieval
  remain follow-on work.
- [Home](../../src/local-ui/pages/index.vue) lists saved simulations with Continue,
  the example and Create your own/Studio routes, plus separate browser workspace
  recents. [The last crossing](LAST_CROSSING.md) starts or resumes one database-backed
  example without recompiling on resume. Collection/resume semantics are below.

These are implementation boundaries, not a new live-inference or release claim.
Older broad architecture status lists are not the Stage implementation inventory.

## Selected experience

Stage is where the player directs and performs one actor at a time. Turn 1 and
turn 25 use the same working surface. Keep readable performances central and
operational details available through quiet, keyboard-accessible disclosures.

Home features one recognizable return item with **Continue**, with other items in
a quieter collection. First arrival offers a ready-to-play example and an explicit
**Create your own** route into Studio. Feature the most recently successfully
opened simulation, with other saved simulations quieter. Keep browser workspace recents separate as source shortcuts.
**Production** remains a candidate UI noun, not a rename of simulation or branch.

Use a continuous transcript with avatar/name identity, readable prose and compact
audience information. Avoid separate cards or rules around every turn and repeated
Accepted labels. Drafts, failures and active revisions retain explicit textual
boundaries. Use **Actor state** for the target inspection entry, subject to the
policy gate below; the current identity overlay must remain honestly labeled.
Spacing polish is deferred; Continuous script is no longer an open comparison.

Established history opens at the latest turn. Non-navigational updates preserve
the reader's position. Show **Jump to latest** just above the composer only when
the latest turn is offscreen. Resume places the caret at the end of the draft,
including its existing prose line after routing; repeated resume adds no blank
lines and ordinary typing/picker changes do not reset selection.

## LL-01 collection and durable resume

Home lists one entry per saved simulation in the current database/owner scope,
including the example, legacy and imported runs. The pinned scenario name is the
label; simulation ID disambiguates duplicate names and supplies the missing-name
fallback. Only IDs, that label, creation/opened timestamps and the resume branch
cross the collection transport boundary.

Successfully opened runs precede never-opened runs. Order opened runs by last
successful intentional Stage entry, then creation time and simulation ID for ties;
unopened runs use newest creation time and stable ID ties. Never infer a played
date from creation. Empty Home retains Play the example and Create your own;
populated Home also retains those routes. Listing never creates the example.

Continue carries simulation and branch IDs and loads that branch's current head
from pinned content, independent of source paths, compilation or model availability.
A known missing simulation/branch shows a recoverable failure and Back to simulations,
without silently switching branches or offering the source Start flow.

Navigation is installation-local application data in separate additive tables,
not canonical events, drafts or portable archive content. Stage records it only
after successful projection/recovery load during intentional entry. Polling,
refresh, browser reload, failed loads and background work do not promote items.
An owner-scoped version check rejects stale writes; a stable operation identity
makes duplicate receipt retries harmless. Concurrent entries use first successful
write wins; a conflicting entry remains playable with an honest warning. A lost
response is reported as an unconfirmed save, because the server may have applied it.
There is one version row per owner and one resume row per simulation, without a
navigation event log. Late results cannot replace another view's state. Metadata
failure leaves the playable projection and editor intact.

This bounded slice adds Home collection and Stage entry metadata/error handling.
The continuous transcript and navigation baseline was already delivered before
this slice; composer/routing, historical revision, Actor state and briefing remain
under their existing contracts. Production browser integration, real phone keyboards
and assistive-technology validation remain separate; LL-01/#15 is not closed here.

## Composer, private direction and routing

The bounded picker implementation now follows [Composer Routing](COMPOSER_ROUTING.md).
Its versioned proposal policy separates observation from delivery; legacy drafts
retain fixed routing and their historical context interpretation. The notation
requirements below remain a target, not shipped grammar.

Merged #30 implements #29 complete-whisper replacement on #27's candidate
lifecycle. Routed responses are projected on the server; legacy full-record
responses remain as described above. The historical contract owns the remaining
minimization boundary.

The selected vocabulary is **Stage whisper / Perform**, **Generate draft**,
**Original stage whisper**, and **draft performance**. The original private
instruction and resulting performance are separate objects. Mode switching
preserves input rather than copying private instruction into spoken prose.
Manual Perform keeps its immediate, explicit commit until a separate manual
preview decision is made. Current Stage opts these new submissions into the
[actor-knowledge policy](ACTOR_KNOWLEDGE.md), so delivery creates receipt, not
automatic mutual observation. Legacy manual commands retain their saved semantics.
Current Stage complete-whisper revisions likewise opt into the new policy even
when their saved source is legacy; exact Retry and Accept keep the source policy.

Optional typed `#actor` / `@audience` notation and pickers share explicit routing
state in both directions; typing syntax must never be required. Opening guidance,
composer controls and notation operate on the same active draft, not separate
setup forms. Preserve each mode's prose and routing across switching, reopening
and refinement; candidate corrections retain their own state. Select one actor
and an arbitrary audience subset. Within an explicit performance-routing scope,
recipient occurrences form a deduplicated whole-turn union, including inline
occurrences; there are no passage-level deliveries. Removing one occurrence keeps
a recipient if another remains. Unknown identities or multiple actors require
correction. Plain names in prose never route.

**All** is a bulk selection of concrete supported cast IDs from the pinned
revision, with individual deselection available. It grants no new access and does
not remove the sender's own perception. No new aliases such as `@none` or
`@everyone`, or blank-audience behavior, are approved by the study. Preserve the
supported explicit-ID API and sender-own perception invariant.

The endorsed direction allows a natural-language stage whisper to request a
**draft plus proposed audience**, without mandatory audience selection up front.
The bounded picker flow now follows #27's engine/API contract. The study used
fixed replies and fixed audience proposals, so the study itself proves neither
inference nor validation.

The selected actor receives the private whisper; the reviewed audience perceives
the accepted performance. A request to tell one person about another must not
silently include the person merely named. Explicit `@` scope inside a private
whisper still needs a deliberate distinction from resulting output routing.
The earlier hypothesis that every mention anywhere automatically routes the
performance must not be carried into this new flow without that scope decision.
Natural-language intent is a candidate interpretation,
not a lossless counterpart of picker metadata.

The shipped revised-candidate contract validates audience corrections at a fixed
actor/basis, with explicit review of final performance and concrete recipients.
Generated routing is untrusted staged data and delivers nothing. Acceptance must
never rebind a fixed candidate under new metadata. Actor changes require a fresh
operation; notation and broader effects remain outside that bounded contract.

## Complete-whisper replacement (#29)

Ordinary draft refinement edits the **complete stage whisper** used for the prior
candidate. Generate afresh uses only the latest complete version, including an
intentional empty whisper, with the same actor and pre-turn context. Earlier
whispers and unaccepted performances remain immutable provenance outside model
input. Recompute implicit recipient references after deletion; preserve explicit
audience decisions separately and validate the resulting proposal before review.
Each successive generation opens its own captured complete whisper for editing.

Performance editing remains text-only. **Keep performance · apply audience**
creates an explicitly director-derived candidate without generation, and cannot
pretend to apply a changed whisper. Retry repeats captured input; unsent whisper
or audience changes block Retry/Accept until applied or cleared. Session-local
buffers retain empty deletions across candidate switching and terminal recovery.
Legacy additive inputs remain labeled as legacy; a complete replacement must be
provided explicitly rather than synthesized from original-plus-correction text.
See [Composer Routing](COMPOSER_ROUTING.md) for versioning and receipt semantics.
Historical editing, browser-close autosave and notation remain separate work.

## Historical revision

The bounded [Historical Revision contract](HISTORICAL_REVISION.md) specifies #17's
operation identity, parent basis, provenance, transport, acceptance and recovery
requirements against merged #30. It preserves this selected interaction design and marks
unresolved policies explicitly; it does not claim implementation.

Revision belongs **inline at the selected historical turn**, with only one active
editor. Hide and preserve the normal continuation composer, its mode buffers and
any candidate while revising; cancel restores them. A waiting continuation must
be resolved or explicitly cancelled before conflicting historical work begins.

Offer editing the performance, regenerating from the selected turn's latest
recorded complete whisper, or editing that complete whisper to generate again.
Use only the latest complete version (including deliberate empty) and the original
actor's **pre-turn context**. Earlier whispers, additive correction feedback,
accepted/source performance and prior attempts never enter new historical generation.
Source/derivation remains provenance outside model input. Recompute implicit
recipient references from current input; prose changes preserve explicit audience
decisions. These generation semantics are settled by #29/#30.

Display exact available original provenance separately from generation input.
Legacy additive or multiple-input origins cannot be invented into a complete
whisper: require explicitly entered complete replacement, including deliberate
empty confirmation. Preserve legacy frozen records and exact retry interpretation.
If direction was absent or provenance is unavailable, label that state honestly
and allow explicit new direction. The approved owner/director retrieval policy
uses a dedicated scoped response without raw prompt/context or unrelated whispers;
that endpoint and historical operations still require implementation.

Unsaved inline edits and the suspended continuation must survive browser close/reopen
through browser-local autosave. Saved candidates remain server durable; local
buffers have no cross-device sync. Storage failure, scope conflicts and late-response
recovery follow the historical contract, not merely navigation warnings.

An accepted replacement creates an alternate path from the selected turn's parent.
The original path and original candidate remain available. Old descendants,
perceptions, memories and closures are not inherited by the replacement. A
preserved continuation candidate stays bound to its original branch/head; returning
to it must restore that basis, not offer it against the alternative history.

Historical regeneration creates/selects an alternative immediately after validated
generation and safe commit, without a separate Accept UI. Cycle alternatives at
the branching turn, each with its own continuation. This does not alter ordinary
continuation Accept or manual editing. Keep unsupported effectful cases gated;
blanket blocking was only a recommendation. Delivery follows #25: #32 context
correction, then #17 saved alternatives engine/API, then UI cycling/recovery. Implementation PRs require independent review and human merge;
partial deliveries do not automatically close #17 or change #18, #19 or #28 scope.

## Actor state and player orientation gates

Actor inspection should explain available runtime state at the historical turn
through its avatar/name. **Before this turn** by default with an **After this turn**
comparison is a proposed temporal treatment, not a settled policy. Decide owner
and access authorization, temporal projection and available fields before exposing
beliefs, memories, goals or perceptions. Show provenance and unavailable data
honestly. Never invent model hidden reasoning, dump raw context, bypass the current
safe identity contract, or pass one actor's hidden state to another actor.

World/scenario-specific player orientation is requested, but its authored source
and player-visible projection remain unresolved. A short authored briefing,
reopenable through scene identity, is a proposed treatment. It must not become an
implicit canonical source dump, accepted turn, actor knowledge or perception.
Until a content/projection contract is decided, retain pinned scenario identity only.

## Invariants and regression gates

- Exactly one supported actor owns each committed turn, including supported
  stateless actors. Opening is an ordinary turn retained in history. No mandatory
  narrator, injected scene actor, omniscience or model-selected automatic turns.
- Accepted history is immutable. Context reads are pure. Private direction is
  actor/head-bound, consumed only on acceptance, and not automatically truth or memory.
  Generation, retry, discard and orientation create no canonical turns/perceptions.
- Preserve expected-head validation, idempotent commands and command leases until
  both mutation and projection converge. Lost responses, double clicks, projection
  failures and late results must not duplicate work or act on another candidate.
  Guard asynchronous results against API/simulation/branch changes.
- Preserve durable discovery, API-restart recovery, stale rejection, restricted
  perceptions, original candidates and unsaved-edit handling across all new flows.
- Review opening, long history, pending/failed drafts and inline revision at
  1440×900, 1280×600, 390×844 and 360×640, including keyboard/focus, scrolling,
  overflow and reachable actions. Real phone keyboards and assistive technology
  need production validation; scripted study checks are not accessibility certification.

Implementation slices require focused behavioral checks and the repository's
final `check` and `ui:build` gates with Node >=24. This docs-only handoff runs no
production tests. Keep Nuxt/Nuxt UI, shared contracts and focused clients; the
private disposable study remains reference material, never a maintained frontend
or a source of production fixtures, portraits or engine code.

## Related contracts

- [Target Architecture](ARCHITECTURE.md)
- [Branching and Memory](BRANCHING_AND_MEMORY.md)
- [System Loop](SYSTEM_LOOP.md)
- [Adoption plan](LIVING_LIBRARY_ADOPTION.md)
