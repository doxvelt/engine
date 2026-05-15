# Doxvelt

Doxvelt is an early-stage design for a turn-based chat RPG and role-play simulation engine where every actor receives subjective context.

The goal is not a normal group chatbot. The goal is an engine where agents, affiliations, artifacts, memories, secrets, mistaken beliefs, and player direction can produce emerging social dynamics for games, education, strategy work, and training simulations.

The first product target is a local single-user app. Simulations and games should be portable through import/export before Doxvelt grows hosted collaboration or publishing features.

## Core Idea

Canonical reality is singular, but access to it is subjective.

Jade can know she is undercover. Mike can wrongly believe Luke is loyal. Pete can suspect Mike loves Jade. The Mafia can trust Jade while Jade is loyal to the police. Each actor's turn is generated from the context available to that actor, not from omniscient world state.

## Current Design

The design is documented in:

- [Ubiquitous Language](docs/design/UBIQUITOUS_LANGUAGE.md)
- [Subjective Context Model](docs/design/SUBJECTIVE_CONTEXT_MODEL.md)
- [Entity Dossier Format](docs/design/ENTITY_DOSSIER_FORMAT.md)
- [System Loop](docs/design/SYSTEM_LOOP.md)
- [MVP Architecture](docs/design/MVP_ARCHITECTURE.md)

## Example Uses

- Chat RPGs with player-directed turns and subjective character knowledge.
- Strategy education where students interview modeled executives, stakeholders, competitors, or regulators to understand what is going on.
- Training simulations such as supply-chain coordination games, crisis-response exercises, negotiation rooms, and mission reenactments.
- Scenario planning where different actors hold partial, stale, or conflicting beliefs.

## MVP Shape

- Turn-based RPG in chat form.
- Exactly one actor acts per turn.
- The player chooses who acts next.
- Actors can be agents, affiliations, stateless generators, or player characters.
- The engine assembles subjective context for the selected actor.
- A shared transcript grows over time, but access is filtered by audience membership.
- Episode closure generates memories and extracts beliefs.
- Closed episodes are immutable.

## Source Assets

A Doxvelt simulation is assembled from source assets on disk:

```text
world/
  models/
  worlds/
  scenarios/
  formats/
  entities/
  connections/
```

- `models`: JSON/YAML metadata for LLM endpoints.
- `worlds`: unstructured Markdown describing immutable laws and norms.
- `scenarios`: unstructured Markdown describing the objective starting situation.
- `formats`: Markdown describing turn output schemas.
- `entities`: dossiers for agents, affiliations, artifacts, and stateless actors.
- `connections`: authored links between entities, including membership-like access.

## Entity Dossiers

Users should not have to author graph records directly. They write natural-language dossiers with lightweight mentions and tags:

```md
@jade is undercover inside @mafia. :canonical :hidden
@pete suspects @mike loves @jade. :+1
@jade usually appears calm. :surface:in_person,video :+3
This connection gives @jade access to @mafia knowledge. :access:member
```

The engine compiles this prose into runtime fabric: entities, connections, propositions, beliefs, events, surfaces, and memories.

## Status

This repository currently contains design documents and the first local CLI slice.

Try the current slice:

```sh
bun run doxvelt -- init world/demo
bun run doxvelt -- compile world/demo --json
bun run doxvelt -- start world/demo --scenario executive-interviews --json
bun run doxvelt -- actors --json
bun run doxvelt -- turn ceo --manual "We need to understand what is really going on." --audience ceo,student-team --json
bun run doxvelt -- context ceo --json
bun run doxvelt -- close-episode --label "Opening interviews" --json
```

If a local OpenAI-compatible endpoint is running, try an AI-backed turn:

```sh
bun run doxvelt -- turn coo --ai --model local-openai-compatible --audience coo,student-team --json
```

The next implementation step is belief extraction from episode memories.
