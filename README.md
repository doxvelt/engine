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

On Home, choose **Play the example** to open **The last crossing** directly on Stage.
Mara, Nell and Corin meet at the last ferry before a storm. Choose an actor and
an audience, then use **Perform** to commit your own words or **Direct** to generate
and review a draft. There is no required narrator or opening script.

The app creates its own source copy beside the local database and resumes the
same example on later clicks, including after restart. It never refreshes that
copy over your edits or replaces accepted history. Studio remains available for
source authoring; Executive Interviews remains an inspectable template.

Generation needs a deployment-configured runtime; manual Perform works without
one. See AI Drafts below and the [slice scope](docs/design/LAST_CROSSING.md).

## What You Can Do Today

- Create or seed a local simulation workspace.
- Author worlds, scenarios, formats, models, entities, and connections as files.
- Compile Markdown source into inspectable runtime fabric.
- Play branch-aware hard-turn scenes on Stage, through the CLI or local API.
- Control who is in the audience for each turn.
- Add private stage whispers for one actor's next turn.
- Grant and revoke runtime access without editing source files.
- Edit, regenerate, and fork accepted history without destroying its original branch.
- Close episodes to write actor-specific memories and extract beliefs.
- Revise or retract memories on one branch without contaminating siblings.
- Request, inspect, observe failures, and retry causally anchored memory jobs
  through the local API.
- Export and import local simulation packages.

Doxvelt is local single-user software. Hosted accounts, collaboration,
publishing and marketplaces remain outside this slice.

## Architecture Direction

The current implementation includes the branch-aware manual kernel and
memory/closure slice. Content revisions, commits, message versions, branches,
audience/access effects, first impressions, perceptions, memory operations,
jobs, and beliefs are immutable or append-only and projected at a selected
branch head. Portable schema-v5 archives carry explicit branch origins, memory
jobs, transitions, and detached operations; schema-v4 archives are validated
before deterministic upconversion. SQLite is the first adapter behind
storage-neutral domain/application ports. The Pi actor-turn adapter and durable draft lifecycle are implemented. General
capability mediation and sandboxed executable helpers remain outside this slice.

Slice 2 derives stable message-perception records from committed audiences and uses them as memory provenance. Generalized perception for non-message world events remains later work.

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
- validated `pi-ai` `Models` plus `pi-agent-core` `Agent` as a replaceable
  model/auth/tool-loop adapter;
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

Stage is the visual play surface. The CLI also supports automation and inspection; Studio handles source authoring.

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

The local API additionally exposes memory revision/retraction and explicit
memory-job request, run/retry, list, and transition-history routes. The
synchronous CLI `close-episode` command composes a durable closure request with
an immediate job run.

Export and import a local package:

```sh
bun run doxvelt -- export workspaces/package-export --json
bun run doxvelt -- import workspaces/package-export --world workspaces/imported-demo --db .doxvelt/imported-runtime.sqlite --json
```

## AI Drafts

Model output is a durable, non-canonical draft until accepted. Stage uses
`POST /simulations/:id/drafts`, followed by explicit acceptance or discard.
Saved drafts can be recovered after reload or API restart.

Configure the existing Pi runtime on the API process, separately from authored
content. For example, with a locally installed compatible model:

```sh
bun run api -- --runtime-base-url http://localhost:11434/v1 --runtime-model YOUR_MODEL --runtime-context-window 16384 --runtime-max-tokens 768
bun run ui
```

For an authenticated runtime, supply `DOXVELT_RUNTIME_API_KEY` in the API process
environment. Credentials and endpoint configuration do not belong in the example.
The legacy blank scaffold still contains `models/` metadata; this slice does not
migrate that authoring contract.

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
- `examples/last-crossing`: the playable Home example.
- `examples/executive-interviews`: the retained authoring/inspection example.

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
