# Agent Notes

This repository is in early design formation. The current task is not to implement a generic chatbot. It is to design and eventually build Doxvelt: a turn-based chat RPG and role-play simulation engine with subjective context, social knowledge, beliefs, memories, affiliations, artifacts, and player-directed turns.

Read these first:

1. `docs/design/UBIQUITOUS_LANGUAGE.md`
2. `docs/design/SUBJECTIVE_CONTEXT_MODEL.md`
3. `docs/design/ENTITY_DOSSIER_FORMAT.md`
4. `docs/design/SYSTEM_LOOP.md`

Doxvelt can support entertainment play, education, strategy work, and training simulations. Preserve the hard-turn, subjective-context model even when adding non-game examples such as executive interviews, crisis exercises, or coordination simulations.

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
world/
  models/
  worlds/
  scenarios/
  formats/
  entities/
  connections/
```

Worlds and scenarios are objective canonical truth only. Subjective context comes from entities, connections, beliefs, memories, surfaces, and access.

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

## Context And Episodes

Context assembly should include everything accessible until the context becomes too large. Retrieval and ranking can come later.

Access is tracked by active audience membership and restricted-audience metadata. Actors can observe without acting if they remain active but are not selected for a turn.

Episode closure is player-triggered, blocking, and memory-first:

```text
subjective transcript/context -> memories -> extracted beliefs -> belief history
```

Extraction happens at episode closure for MVP, not after every turn.

## Implementation Guidance

Prefer making design decisions explicit in `docs/design/` before coding large mechanics.

When implementing, preserve source spans from compiled records back to dossier prose. The graph is generated fabric, and users tune prose when compilation goes wrong.

Avoid over-structuring authoring files. Natural language is the main interface; tags are compiler hints.

Do not add social-coding artifacts such as `LICENSE` or `CONTRIBUTING.md` unless the user asks.
