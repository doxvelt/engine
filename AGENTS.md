# Agent Notes

This repository is in early design formation. The current task is not to implement a generic chatbot. It is to design and eventually build Doxvelt: a turn-based chat RPG and role-play simulation engine with subjective context, social knowledge, beliefs, memories, affiliations, artifacts, and player-directed turns.

Read these first:

1. `docs/design/UBIQUITOUS_LANGUAGE.md`
2. `docs/design/SUBJECTIVE_CONTEXT_MODEL.md`
3. `docs/design/ENTITY_DOSSIER_FORMAT.md`
4. `docs/design/SYSTEM_LOOP.md`
5. `docs/design/MVP_ARCHITECTURE.md`

Doxvelt can support entertainment play, education, strategy work, and training simulations. Preserve the hard-turn, subjective-context model even when adding non-game examples such as executive interviews, crisis exercises, or coordination simulations.

The first product target is a local single-user app with import/export for simulations and games. Do not assume hosted accounts, real-time collaboration, or a marketplace in MVP. Packaging and distribution are undecided.

The current implementation includes the core engine, local SQLite store, CLI/runtime slice, local HTTP API, and Nuxt local workbench UI. Keep new simulation behavior in the core library first, then expose it through the CLI and local API as sibling wrappers. The UI should call the local API rather than shelling out to the CLI.

## Design System

The product design system lives in `design-system/`. It contains the static specimen page, canonical visual tokens, fonts, and brand assets for Doxvelt's local workbench UI.

Use the design system when changing UI surfaces. Preserve its Doxvelt-specific semantics for source spans, dossiers, beliefs, access paths, transcript turns, tags, badges, authoring fields, and restrained operational states. Do not invent parallel palettes, badge semantics, typography scales, or component treatments without updating the design system first.

Keep `docs/design/` for product/domain design documents and `design-system/` for visual/product UI language.

## Core Product Shape

The engine is a turn-based RPG in the form of a chat.

- Exactly one actor acts per turn.
- The player chooses the next actor.
- The transcript grows incrementally.
- The engine assembles subjective context for the selected actor.
- Episode closure writes memories and extracts beliefs.
- Closed episodes are immutable in MVP.

Do not introduce simultaneous multi-agent orchestration for MVP. The hard-turn constraint is intentional because it avoids reconciliation problems.

## Source Versus Runtime

The authored source is natural-language dossier material on disk. The runtime graph is compiled fabric.

Do not make users author graph atoms directly. Users should write dossiers, connections, worlds, scenarios, formats, and models.

Planned source layout:

```text
workspaces/demo/
  models/
  worlds/
  scenarios/
  formats/
  entities/
  connections/
```

Worlds and scenarios are objective canonical truth only. Subjective context comes from entities, connections, beliefs, memories, surfaces, and access.

Compiled source is the starting fabric. Runtime changes such as turns, audience changes, stage whispers, access grants/revokes, memories, first impressions, and extracted beliefs are append-only runtime state.

## Entity Kinds

MVP entity kinds:

- `agent`
- `affiliation`
- `artifact`
- `stateless`

Agents, affiliations, and artifacts can hold beliefs. Stateless entities are invokable generators or assistants and do not hold evolving beliefs or memories.

## Dossier Rules

Entity folders use files such as:

- `IDENTITY.md`
- `STATE.md`
- `SURFACE.md`
- `BELIEFS.md`
- `MEMORY.md`
- `EXAMPLES.md`

Connection files cover both relationships and memberships. A membership is a connection with engine-recognized access mechanics.

Use lightweight mentions and line tags:

```md
@jade is undercover inside @mafia. :canonical :hidden
@pete suspects @mike loves @jade. :+1
@jade usually appears calm. :surface:in_person,video :+3
This connection gives @jade access to @mafia knowledge. :access:member
```

Tags use `:` and apply to the whole line.

## Belief Model

Beliefs are holder-specific stances toward propositions.

MVP scale:

- `+3`: treats as true
- `+1`: suspects or leans true
- `0`: no stance or neutral
- `-1`: doubts or leans false
- `-3`: treats as false

Characters can confidently believe false things. Do not collapse belief into canonical truth.

Secrets are not a separate content type. Secrets emerge from lack of access.

Belief provenance matters. Current code distinguishes held beliefs, beliefs accessed through membership-like paths, observed/first-impression beliefs, and beliefs retained after access loss.

Losing access to a source removes live access to that source's current beliefs. It does not erase what an actor already encountered. Persistent retained knowledge should be created through episode closure and weakened in confidence, preserving the belief direction.

## Context And Episodes

Context assembly should include everything accessible until the context becomes too large. Retrieval and ranking can come later.

Access is tracked through authored membership-like access links, runtime access events, active audience events, and restricted-audience turn metadata. Actors can observe without acting if they remain active but are not selected for a turn.

Runtime access changes are explicit grant/revoke events. They affect effective context access without editing authored source files.

Active audience is runtime state. By default, a turn's audience is the selected actor plus the current active audience. A per-turn audience override can create private or restricted turns, but the selected actor is always included.

Private conversations are normal turns with restricted audience metadata. Stage whispers are private player-supplied context for one target actor's next turn. They are consumed when that actor's turn is appended and do not automatically become memories or beliefs.

Projected surfaces are included for entities the actor can currently observe. The first time an actor observes another entity, Doxvelt deterministically stores a `+1` first-impression belief derived from that entity's first projected surface line. AI-generated or player-reviewed impressions are future work.

Episode closure is player-triggered, blocking, and memory-first:

```text
subjective transcript/context -> memories -> extracted beliefs -> belief history
```

Extraction happens at episode closure for MVP, not after every turn.

Closed episodes are immutable. If an actor was absent, inactive, or excluded from the turn audience, they should not write memories from that turn unless they later learn about it through a new accessible event.

## Current Local Interface

The current local app surfaces are:

- `src/local-ui`: Nuxt workbench UI with Home, Studio, and Stage pages.
- `src/local-api`: local HTTP API over the same core engine and SQLite runtime store.
- `src/cli`: CLI wrapper for users, tests, automations, coding agents, and future LLM tools.

Run both the API and UI during local UI work with:

```sh
bun run dev
```

The API defaults to `http://127.0.0.1:8787` and `.doxvelt/runtime.sqlite`. The UI reads `DOXVELT_API_BASE` or falls back to that API URL.

The current CLI surface includes:

- `init`, `compile`, `start`, `actors`, `context`, `turn`, and `close-episode`
- `audience add/remove/deactivate/reactivate/list`
- `access grant/revoke/list`
- `whisper`, `whisper list`, and `turn --whisper`
- `transcript`, `memories`, and `beliefs`
- `export` and `import`

Exported local packages are plain directories containing source material, runtime SQLite state, and a manifest. Do not include secrets such as API keys in exports.

## Implementation Guidance

Prefer making design decisions explicit in `docs/design/` before coding large mechanics.

Doxvelt owns simulation semantics. Use a mature AI substrate for provider mechanics. The preferred MVP substrate is Vercel AI SDK behind a thin Doxvelt generation boundary; do not build a custom provider matrix, streaming protocol, model gateway, inference runtime, or authentication framework.

Treat the core engine as a library, not as the CLI. The CLI is a first-class wrapper for users, tests, automations, coding agents, and future LLM tools. A future local API server should be a sibling wrapper over the same core engine, not an HTTP wrapper around the CLI.

When implementing, preserve source spans from compiled records back to dossier prose. The graph is generated fabric, and users tune prose when compilation goes wrong.

Avoid over-structuring authoring files. Natural language is the main interface; tags are compiler hints.

Do not add social-coding artifacts such as `LICENSE` or `CONTRIBUTING.md` unless the user asks.
