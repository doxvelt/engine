# Stage Experience

**Status:** First bounded conversation-centred production slice approved. The production decisions below supersede earlier interaction hypotheses for this slice; notation experiments remain deferred. The opening decision is resolved below. This subset is implemented and locally verified in the working tree with deterministic runtime integration tests and production browser checks; this is not a release or live-inference claim.

## Approved production subset

Implement this slice in the existing Nuxt/Nuxt UI Stage using canonical design-system tokens and existing assets. The disposable study is a visual reference only; its scripted replies, fictional fixtures, embedded assets and editor implementation are not production content or architecture.

- Use one conversation surface at opening, established history and pending draft: compact scene/run header, independently scrolling readable history, and anchored composer or review actions. Retain the accepted opening as the first turn in history. Empty scenes start at the top; updates preserve deliberate reading position and offer Jump to latest. Short laptop and mobile layouts must keep actions reachable.
- Provide compact **Direct / Perform** controls with independent buffers and explicit submission labels. Direct stages private instruction for the selected actor and generates a durable Pi draft. Perform commits user-authored text through the supported manual-turn API. The Perform label makes that commitment explicit; this slice adds no durable manual-draft lifecycle. Switching modes never copies private direction into performance prose.
- Use **Actor** and **Audience** pickers, with Actor on the left and Audience on the right and no arrow. Keep the chosen actor after acceptance or performance. Resolve `all` to the concrete supported authored actors listed by Stage from the pinned revision, and send explicit IDs through both APIs. This explicit whole-turn selection does not edit the persistent presence roster (which is initially empty); it is not a fallback from an empty roster. It is not an unrestricted audience alias. Invalid identities fail without widening delivery. Restricted delivery must produce restricted perceptions.
- Display avatar and readable identity in transcript headers. Identity opens a small accessible overlay limited to safe identity/public authored metadata; it must not expose another actor's subjective context or beliefs. Turn numbers, accepted state and provenance belong in optional keyboard-accessible details.
- Display generated text as an explicitly marked, read-first draft. Edit reveals the editor; Retry, Accept and Discard remain at the conversational edge. Review shows the captured actor and audience, which cannot be rebound at acceptance. Retry uses the durable lifecycle and preserves the original actor, audience and private direction where the basis still permits it. Accepted history remains immutable. Retry creates another durable candidate and keeps the earlier draft reachable in Saved drafts; it does not overwrite or silently discard it.
- Discover recoverable drafts through a small owner/simulation/branch-scoped repository/API read, including when a generation response never reached the browser. Reopening or reloading must reveal ready, failed and in-progress records, detect stale bases, exclude terminal records from pending discovery, and expose multiple recoverable drafts in a deterministic, visible order. A browser pointer alone does not meet this requirement. Recovery must survive API restart.
- Distinguish saved artifact text from unsaved review edits. Refresh must preserve unsaved edits; an explicit unsaved label and navigation warning are sufficient. No autosave subsystem is required. If another session accepts or discards the record, refresh shows its terminal status while retaining unsaved local wording for review.
- Empty-state orientation uses pinned scenario identity only and creates neither turns nor perceptions. An opening performance is an ordinary turn: only Perform or acceptance advances history. Never fabricate scene action from hidden statements or grant stateless actors additional knowledge.
- Remove repetitive machinery explanations, large heading cards and ornamental composer dividers. Text inputs do not advertise or interpret routing syntax in this slice.

### Verification and exclusions

Changed semantics require focused RED/GREEN tests. Preserve command leases until both mutation and projection converge: lost responses, double clicks, retries and projection failures must not duplicate turns or drafts or discard a different artifact. Guard asynchronous results against API/simulation/branch changes. Generate, retry, discard and orientation display must leave canonical turn/perception counts and previous commits unchanged; only Perform or accepted generated drafts advance history. Private direction remains actor/head-bound and is consumed only on acceptance.

Verify discovery isolation, restart recovery, stale acceptance rejection, actual restricted perceptions, independent mode buffers, stable actor selection and preservation of unsaved edits. Check opening, established history and review at 1440×900, 1280×600, 390×844 and 360×640, including keyboard access, page overflow and older-history reading position. Required final gates are `check` and `ui:build` with Node >=24. Deterministic injected runtime checks demonstrate integration, not live inference.

Excluded: routing chips or parsers (including model-output parsing), Home/Studio redesign, a new demo world, new engine capabilities or memory systems, runtime/model selection UI, run management, branch trees, context inspectors, containers/deployment, new maintained dependencies and global format/compilation redesign.

### Resolved opening: an ordinary turn

The opening is turn 1. An authored stateless actor such as Scene can be selected alongside supported agents, privately directed to generate a draft, or performed manually. Its opening remains in ordinary history after acceptance. A production without Scene starts with an ordinary character; Stage never injects an actor or mandates a narrator.

Scene-setting turns use the same audience, perceptions, expected-head, acceptance and ownership rules at turn 1 and later. Stateless ownership grants no omniscience, new access, canonical world-mutation privileges or memory behaviour. Verify ownership through both real manual and durable-generation seams without weakening privacy.

An empty Stage may display pinned scenario identity and a concise neutral invitation to choose an actor. It displays neither synthetic setup prose nor hidden scenario content nor format listings. There is no special pre-transcript opening renderer. Selected-format state and any new format-selection contract remain deferred, not blockers for this slice.

## Purpose

Stage is where one person directs and performs a scene. It should feel familiar to someone who uses text-based agents without disguising Doxvelt's distinctive semantics. A person should encounter the value of simulation before having to author a world in Studio.

Design the beginning and the middle together: turn 1 is an empty-state variation of the same working surface used at turn 25, not a separate onboarding interface.

## Experience invariants

1. **Conversation is central.** Prioritise readable performances over setup, diagnostics, and administrative cards. Stage is a working surface, not a marketing page or inspection dashboard.
2. **Orientation and action remain reachable.** Keep human-readable scene/run identity and the composer stable while history scrolls. Do not force a reader back to the latest turn merely because state changes; provide an explicit route back.
3. **Typing has an explicit meaning.** Distinguish performing an actor's words/actions from privately directing a model-generated performance. Identify the acting character, input intent, and resulting audience before submission. Private direction is not in-world dialogue, canonical truth, or knowledge shared with other actors.
4. **Generation is not acceptance.** Present a generated performance as a proposed next turn, outside accepted history, with a textual status that does not depend on colour. Review, edit, retry, and discard belong near the proposal. Prioritise reading before editing.
5. **Consequences are legible.** Acceptance advances history; discarding a proposal does not. Explain the boundary without repeated modal confirmation for ordinary turns. Never suggest that accepted history can be silently rewritten; corrections require an alternate path under the engine's branch semantics.
6. **Progressive disclosure preserves agency.** Keep actor, input intent, audience, and draft status visible. Reveal raw prompts, engine identifiers, provider metadata, source spans, and deeper inspection only when requested. A quieter screen must not become an ambiguous one.
7. **The interface does not become the engine.** UI state cannot confer knowledge, grant access, choose canonical truth, or bypass expected-head and draft validation. Labels and controls must reflect real capabilities; unavailable features must not imply success.
8. **Existing layouts are hypotheses.** Keep Doxvelt's visual tokens and engine guarantees, not accidental arrangements. Production remains Nuxt/Nuxt UI unless a concrete requirement warrants a separate decision. Disposable prototypes are not new maintained frontends.

## Earlier interaction hypotheses (historical design study)

These treatments describe the earlier study. The approved production subset above takes precedence, including Actor/Audience terminology, immediate manual Perform and the resolved ordinary-turn opening:

- A compact scene header, independently scrolling transcript, and anchored composer.
- Compact **Direct / Perform** choices within one composer, with distinct text buffers and submission labels. Never reinterpret existing input silently when switching intent.
- A proposed performance at the transcript's leading edge of new history; acceptance promotes it into history without relocating the next-action area.
- The special format-native opening hypothesis is superseded: scene-setting is an ordinary actor turn, retained at the start of history.
- Scene identity uses pinned metadata. The earlier separate setup-brief hypothesis is superseded; private direction stays in the draft transaction.
- Sender on the left of a turn header; recipients on the right. The audience control can reveal turn number, provenance and accepted state on tap or keyboard activation. Accepted history is the unmarked default; a draft keeps an explicit textual boundary.
- Remove redundant composer dividers, next-turn counters, repeated role instructions and a second review-panel heading. Preserve actions, not duplicate explanations.
- Keep the acting character explicit after acceptance; do not silently advance to a different actor unless a scenario-defined rule is disclosed.

Whether manually written performances need a separate preview is an open design decision. Their commit semantics must be explicit either way. Audience controls and draft retries must map to actual domain operations before production integration; a prototype is not proof that those seams exist.

## Future notation semantics — deferred from production slice

The following intended whole-turn semantics remain design direction only. This slice uses pickers; neither typed notation nor model output is parsed for routing.

`#nell @mara “Mara. A word.” Nell steps toward the mooring post, away from the passenger.`

- `#` identifies the single sender. `@` identifies recipients. One other recipient means a direct turn without a separate direct-message mode.
- **Every explicit @mention applies to the entire turn**, including mentions inside dialogue, private direction, or an agent's proposed response. There are no passage-level audience changes and no separate non-routing “reference mention” interpretation.
- A plain name in prose has no routing effect. “Do not tell @ivo” nevertheless includes Ivo; use the plain name when not issuing a recipient instruction.
- Resolve recipients from all mention occurrences, deduplicate them, and show the complete resulting audience before acceptance. The sender also perceives their own turn. Generated mentions remain staged draft data; they do not deliver anything during generation.
- Leading routing notation may render as a from/to header; in-prose mentions may remain inline. Their audience semantics are identical. Removing one occurrence removes that recipient only if no remaining occurrence includes them.
- Unknown identities and multiple senders require correction; never guess a recipient or silently fall back to public delivery.

The current disposable study tests editable chips, keyboard completion, click/backspace removal, and equivalent #/@ picker buttons. It uses `@everyone` as an explicit fixture-wide recipient set and requires at least one recipient rather than inventing an implicit public default. These alias/default details and the exact editor behaviour remain prototype choices, not a new engine grammar or shipped capability.

Keep prototype limitations in one plain, discoverable notice: example replies are not generated from direction, and nothing is saved. Do not repeat “canned alternative” metadata inside performances.

## Review benchmark

The notation/chip checks below apply only to future editor experiments. Production review uses the pickers and regression requirements in the approved subset.

Evaluate the **same layout** with no accepted turns, a long established transcript, and a pending performance. Check a normal desktop, a short laptop viewport, and a narrow/mobile viewport, including keyboard navigation.

- Can a user identify the situation, current run, acting character, and next action without assistance?
- Can they distinguish writing dialogue/actions from privately directing a performance before submission?
- Is the resulting audience explicit, including private or restricted turns?
- Does an inline @mention, including one emitted in a draft response, update the whole-turn audience visibly without committing it? Does deletion respect other remaining occurrences?
- Can a user type, select, remove and undo routing chips without losing prose or line breaks? Do intent switches preserve separate text?
- Can they tell proposed from accepted content without colour or technical identifiers?
- Can they read, edit, retry, accept, and discard without hunting for controls?
- Does accepting a proposal preserve a predictable route to the next turn?
- Can they read older history without losing their place or scrolling past all history to reach the composer?
- Can the user start with any supported actor, including an authored stateless scene-setting actor, without a mandatory narrator or synthetic brief?
- Are diagnostics optional while creative controls remain understandable?
- Are keyboard focus, controls, and pending-state actions reachable on short and narrow screens?

A convincing empty screen alone is not a pass. Prototype checks establish interaction feasibility, not user comprehension, accessibility certification, engine correctness, or persistence.

## Decision gate and scope

The disposable, explicitly scripted interaction study has led to approval of the bounded production subset above. The opening is resolved as an ordinary turn. Use these criteria in Stage reviews; revise them deliberately when evidence changes the design.

Do not bundle Home redesign, Studio changes, a new demo world, run management, a branch tree, or a full context inspector into the interaction proof. A small synthetic scene is only a fixture, not a new supported content package.

Resumability is a separate trust requirement: a stored draft is not a resumable experience unless reopening Stage can find it and clearly distinguish saved content from unsaved edits. Do not advertise persistence based on a disposable prototype.

## Related contracts

- [Target Architecture](ARCHITECTURE.md)
- [Branching and Memory](BRANCHING_AND_MEMORY.md)
- [System Loop](SYSTEM_LOOP.md)
- [Canonical visual tokens](../../design-system/tokens.css)
