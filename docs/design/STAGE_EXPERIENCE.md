# Stage Experience

**Status:** Design direction agreed; concrete layout and interaction details under evaluation. This is a review contract, not a claim that the current Stage implements every behaviour below.

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

## Interaction hypotheses to evaluate

These are proposed treatments, not immutable requirements:

- A compact scene header, independently scrolling transcript, and anchored composer.
- Explicit **Direct / Perform** choices within one composer, with distinct text buffers and submission labels. Never reinterpret existing input silently when switching intent.
- A proposed performance at the transcript's leading edge of new history; acceptance promotes it into history without relocating the next-action area.
- Opening context in the conversation area, accessible later through a scene brief rather than repeated above every turn.
- Keep the acting character explicit after acceptance; do not silently advance to a different actor unless a scenario-defined rule is disclosed.

Whether manually written performances need a separate preview is an open design decision. Their commit semantics must be explicit either way. Audience controls and draft retries must map to actual domain operations before production integration; a prototype is not proof that those seams exist.

## Review benchmark

Evaluate the **same layout** with no accepted turns, a long established transcript, and a pending performance. Check a normal desktop, a short laptop viewport, and a narrow/mobile viewport, including keyboard navigation.

- Can a user identify the situation, current run, acting character, and next action without assistance?
- Can they distinguish writing dialogue/actions from privately directing a performance before submission?
- Is the resulting audience explicit, including private or restricted turns?
- Can they tell proposed from accepted content without colour or technical identifiers?
- Can they read, edit, retry, accept, and discard without hunting for controls?
- Does accepting a proposal preserve a predictable route to the next turn?
- Can they read older history without losing their place or scrolling past all history to reach the composer?
- Does the opening offer useful scene context rather than a large declaration that nothing has happened?
- Are diagnostics optional while creative controls remain understandable?
- Are keyboard focus, controls, and pending-state actions reachable on short and narrow screens?

A convincing empty screen alone is not a pass. Prototype checks establish interaction feasibility, not user comprehension, accessibility certification, engine correctness, or persistence.

## Decision gate and scope

First validate a disposable, explicitly scripted interaction prototype with the product owner. Record the accepted treatment and unresolved questions here before commissioning the production slice. Use these criteria in Stage reviews; revise them deliberately when evidence changes the design.

Do not bundle Home redesign, Studio changes, a new demo world, run management, a branch tree, or a full context inspector into the interaction proof. A small synthetic scene is only a fixture, not a new supported content package.

Resumability is a separate trust requirement: a stored draft is not a resumable experience unless reopening Stage can find it and clearly distinguish saved content from unsaved edits. Do not advertise persistence based on a disposable prototype.

## Related contracts

- [Target Architecture](ARCHITECTURE.md)
- [Branching and Memory](BRANCHING_AND_MEMORY.md)
- [System Loop](SYSTEM_LOOP.md)
- [Canonical visual tokens](../../design-system/tokens.css)
