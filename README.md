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
workspaces/demo/
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

Model files are resolved from source by ID when an AI turn or AI-backed episode closure runs. Endpoint details such as `base_url`, `model`, and `api_key_env` are operational config, not durable simulation state, so they are not copied into SQLite.

## Status

This repository currently contains design documents, an inspectable example, and the first local CLI slice.

Create a blank source scaffold for your own simulation:

```sh
bun run doxvelt -- init workspaces/demo
```

Or seed the executive-interviews example from [examples/executive-interviews](examples/executive-interviews):

```sh
bun run doxvelt -- init workspaces/demo --template executive-interviews
```

Then try the current slice:

```sh
bun run doxvelt -- compile workspaces/demo --json
bun run doxvelt -- start workspaces/demo --scenario executive-interviews --json
bun run doxvelt -- actors --json
bun run doxvelt -- turn ceo --manual "We need to understand what is really going on." --audience ceo,student-team --json
bun run doxvelt -- context ceo --json
bun run doxvelt -- close-episode --label "Opening interviews" --json
```

Stage whispers are private context for one actor's next turn only:

```sh
bun run doxvelt -- whisper ceo --text "Do not reveal the board panic yet." --json
bun run doxvelt -- turn ceo --manual "We should stay focused on the facts." --json
bun run doxvelt -- turn coo --ai --model local-openai-compatible --whisper "Deflect supplier questions." --json
```

Active audience controls who observes turns by default. The selected actor is always included:

```sh
bun run doxvelt -- audience add student-team --reason "The students enter the room." --json
bun run doxvelt -- audience deactivate coo --reason "The COO takes a private call." --json
bun run doxvelt -- audience list --json
bun run doxvelt -- turn ceo --manual "We should keep this focused." --json
```

Projected surface lines from entity dossiers are included in actor context for entities the actor can currently observe.
The first time an actor observes another entity, Doxvelt automatically stores a deterministic first-impression belief from that entity's projected surface.

Runtime access changes are explicit events. They change effective context access without editing authored source files:

```sh
bun run doxvelt -- access grant ceo student-team --reason "The CEO gives the students briefing access." --json
bun run doxvelt -- access revoke ceo student-team --reason "The briefing window closes." --json
bun run doxvelt -- access list --json
```

Export a portable local package, then import it elsewhere:

```sh
bun run doxvelt -- export workspaces/package-export --json
bun run doxvelt -- import workspaces/package-export --world workspaces/imported-demo --db .doxvelt/imported-runtime.sqlite --json
```

Inspect runtime state:

```sh
bun run doxvelt -- transcript --json
bun run doxvelt -- memories --json
bun run doxvelt -- beliefs --json
```

If a local OpenAI-compatible endpoint is running, try an AI-backed turn:

```sh
bun run doxvelt -- turn coo --ai --model local-openai-compatible --audience coo,student-team --json
```

The default scaffold expects an OpenAI-compatible chat completions endpoint:

```yaml
---
id: local-openai-compatible
provider: openai-compatible
base_url: http://localhost:11434/v1
model: llama3.1
api_key_env: OLLAMA_API_KEY
---
```

For Ollama, start the server with:

```sh
ollama serve
```

Then set `model` to an installed Ollama model. `OLLAMA_API_KEY` may be unset for local Ollama; it is only needed for endpoints that require bearer-token authentication.
