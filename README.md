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

Start the local API and Studio UI:

```sh
bun run dev
```

The API listens on `http://127.0.0.1:8787`. Nuxt prints the UI URL, usually `http://localhost:3000`.

From the UI, create a blank workspace or initialize the `executive-interviews` demo. Then:

- Use **Studio** to edit source files, create assets, validate compilation, and inspect compiled source spans.

Studio/source authoring remains usable in Slice 1. The existing **Stage** UI has not yet migrated to the required branch ID, expected-head, and command-ID contracts, so it is temporarily incompatible with the branch-aware runtime. Use the CLI or local API for simulation play until the later workbench migration is complete.

## What You Can Do Today

- Create or seed a local simulation workspace.
- Author worlds, scenarios, formats, models, entities, and connections as files.
- Compile Markdown source into inspectable runtime fabric.
- Run branch-aware hard-turn scenes through the CLI or local API.
- Control who is in the audience for each turn.
- Add private stage whispers for one actor's next turn.
- Grant and revoke runtime access without editing source files.
- Close episodes to write memories and extract beliefs.
- Export and import local simulation packages.

This is still an early MVP slice. The CLI and local API are the supported Slice 1 play interfaces; full local UI play cannot be claimed until Stage is migrated in a later workbench slice. Doxvelt is local single-user software right now; hosted accounts, collaboration, publishing, and marketplaces are intentionally out of scope for the current product. The target architecture actively avoids local-only domain assumptions.

## Architecture Direction

The current implementation includes the first branch-aware manual kernel. Content revisions, commits, message versions, branches, audience/access effects, first impressions, memories, and beliefs are immutable and projected at a selected branch head. Portable schema-v4 archives carry explicit branch origins and are semantically verified by the domain before import. SQLite is the first adapter behind storage-neutral domain/application ports. Pi integration, capability mediation, and sandboxed tools remain later slices.

Slice 1 derives transcript perception from committed message audiences. First-class generic actor-perception records and structured memory operations remain later slices.

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

The CLI is the supported interactive play surface for Slice 1 and is also useful for tests, automation, and quick inspection. Studio remains the visual source-authoring surface.

Create a demo workspace:

```sh
bun run doxvelt -- init workspaces/demo --template executive-interviews
```

Run a small manual slice:

```sh
bun run doxvelt -- compile workspaces/demo --json
bun run doxvelt -- start workspaces/demo --scenario executive-interviews --branch main --command start-demo --json
bun run doxvelt -- actors --json
bun run doxvelt -- turn ceo --manual "We need to understand what is really going on." --audience ceo,student-team --branch main --expected-head <head-from-start> --command turn-1 --json
bun run doxvelt -- context ceo --branch main --json
bun run doxvelt -- close-episode --label "Opening interviews" --branch main --expected-head <head-from-turn> --command close-1 --json
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

## AI Drafts

Doxvelt commits playable turns only from explicit manual text. Model-backed actor output is generated as a non-canonical draft through API `turn-draft` or CLI `draft`, then may be reviewed and accepted separately with `turn --manual`. Draft generation never advances a branch head.

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

- `src/core`: compiler, branch commands, pure head-relative projections, episode closure, ports, and domain types.
- `src/store`: SQLite branch-event adapter and logical portable-package adapter.
- `src/cli`: local CLI wrapper.
- `src/local-api`: local HTTP API over the core engine.
- `src/local-ui`: Nuxt workbench UI.
- `design-system`: visual tokens, fonts, brand assets, and static UI specimens.
- `examples/executive-interviews`: complete example source workspace.

Accepted runtime state is stored once as content revisions and branch-linked commits; derived context is rebuilt from those records.

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
