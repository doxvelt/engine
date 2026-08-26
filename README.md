# Doxvelt

Doxvelt is a local-first workbench and simulation engine for building and running turn-based chat RPGs and role-play simulations. It is designed to run locally without Doxvelt-hosted infrastructure while preserving a path to a hosted service.

You author a simulation as plain Markdown dossiers and scenario files. Doxvelt compiles that source into a runtime with actors, beliefs, memories, affiliations, artifacts, access paths, stage whispers, and a transcript where exactly one actor acts per turn.

The useful trick: every actor receives subjective context. A character can believe something false, miss a private conversation, remember a stale affiliation secret, or form a first impression from another actor's projected surface.

## Quick Start

Requirements:

- Node.js 24 or newer.
- Bun 1.3.13 or compatible.

Install dependencies:

```sh
bun install
```

Start the local API and UI:

```sh
bun run dev
```

The API listens on `http://127.0.0.1:8787`. Nuxt prints the UI URL, usually `http://localhost:3000`.

From the UI, create a blank workspace or initialize the `executive-interviews` demo. Then:

- Use **Studio** to edit source files, create assets, validate compilation, and inspect compiled source spans.
- Use **Stage** to start a run, choose the next actor, manage the audience, send turns, generate drafts, inspect subjective context, and close episodes.

## What You Can Do Today

- Create or seed a local simulation workspace.
- Author worlds, scenarios, formats, models, entities, and connections as files.
- Compile Markdown source into inspectable runtime fabric.
- Run hard-turn scenes through the UI or CLI.
- Control who is in the audience for each turn.
- Add private stage whispers for one actor's next turn.
- Grant and revoke runtime access without editing source files.
- Close episodes to write memories and extract beliefs.
- Export and import local simulation packages.

This is still an early MVP slice. Doxvelt is local single-user software right now; hosted accounts, collaboration, publishing, and marketplaces are intentionally out of scope for the current product. The target architecture actively avoids local-only domain assumptions.

## Architecture Direction

The current implementation is a working prototype and executable specification. Its runtime is still linear and SQLite-specific; edit, regenerate, fork, branch-aware memory, Pi integration, capability mediation, and sandboxed tools are target architecture rather than implemented behavior.

The reset keeps the proven product ideas:

- prose-first dossiers and source spans;
- hard turns;
- singular canonical reality with subjective actor access;
- beliefs, provenance, audiences, access paths, surfaces, and memories;
- manual generation and portable simulations;
- the Nuxt/Nuxt UI workbench and Doxvelt design system.

The target changes the runtime foundation:

- immutable branch-linked turns and events;
- actor perceptions and memories projected at a branch head;
- generated drafts separated from accepted reality;
- Doxvelt-owned memory and capability validation;
- Pi Agent Harness as a candidate replaceable model/auth/tool-loop adapter;
- local and hosted persistence behind the same domain contracts.

Start with [Target Architecture](docs/design/ARCHITECTURE.md), [Branching and Memory](docs/design/BRANCHING_AND_MEMORY.md), and [Agent Runtime and Security](docs/design/AGENT_RUNTIME.md).

## Workspace Shape

A Doxvelt workspace is a local source folder:

```text
workspaces/demo/
  models/
  worlds/
  scenarios/
  formats/
  entities/
  connections/
```

Entity folders hold files such as `IDENTITY.md`, `SURFACE.md`, `BELIEFS.md`, `MEMORY.md`, and `EXAMPLES.md`. Connections describe relationships, memberships, access, rivalry, ownership, or other links between entities.

Source is intentionally prose-first. Lightweight mentions and tags help the compiler:

```md
@jade is undercover inside @mafia. :canonical :hidden
@pete suspects @mike loves @jade. :+1
@jade usually appears calm. :surface:in_person,video :+3
This connection gives @jade access to @mafia knowledge. :access:member
```

## CLI

The UI is the friendliest way in, but the CLI is useful for tests, automation, and quick inspection.

Create a demo workspace:

```sh
bun run doxvelt -- init workspaces/demo --template executive-interviews
```

Run a small manual slice:

```sh
bun run doxvelt -- compile workspaces/demo --json
bun run doxvelt -- start workspaces/demo --scenario executive-interviews --json
bun run doxvelt -- actors --json
bun run doxvelt -- turn ceo --manual "We need to understand what is really going on." --audience ceo,student-team --json
bun run doxvelt -- context ceo --json
bun run doxvelt -- close-episode --label "Opening interviews" --json
```

Common inspection commands:

```sh
bun run doxvelt -- transcript --json
bun run doxvelt -- memories --json
bun run doxvelt -- beliefs --json
bun run doxvelt -- beliefs ceo --json
```

Export and import a local package:

```sh
bun run doxvelt -- export workspaces/package-export --json
bun run doxvelt -- import workspaces/package-export --world workspaces/imported-demo --db .doxvelt/imported-runtime.sqlite --json
```

## AI Turns

Doxvelt can run in manual mode with no model dependency. AI-backed turns use model records from the workspace.

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

## Local Development

Run the full check:

```sh
bun run check
```

Run the API and UI separately:

```sh
bun run api
bun run ui
```

The UI reads `DOXVELT_API_BASE` and falls back to `http://127.0.0.1:8787`.

Repository landmarks:

- `src/core`: compiler, context assembly, turn engine, episode closure, and domain types.
- `src/store`: SQLite runtime store.
- `src/cli`: local CLI wrapper.
- `src/local-api`: local HTTP API over the core engine.
- `src/local-ui`: Nuxt workbench UI.
- `design-system`: visual tokens, fonts, brand assets, and static UI specimens.
- `examples/executive-interviews`: complete example source workspace.

The listed folders describe the current prototype, not a promise that target module boundaries already exist.

## Design Docs

The deeper product and engine model lives in:

- [Target Architecture](docs/design/ARCHITECTURE.md)
- [Branching and Memory](docs/design/BRANCHING_AND_MEMORY.md)
- [Agent Runtime and Security](docs/design/AGENT_RUNTIME.md)
- [Ubiquitous Language](docs/design/UBIQUITOUS_LANGUAGE.md)
- [Subjective Context Model](docs/design/SUBJECTIVE_CONTEXT_MODEL.md)
- [Entity Dossier Format](docs/design/ENTITY_DOSSIER_FORMAT.md)
- [System Loop](docs/design/SYSTEM_LOOP.md)
- [MVP Architecture](docs/design/MVP_ARCHITECTURE.md)
