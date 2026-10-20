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

The following commands work in POSIX shells and Windows PowerShell.
For generated drafts, configure inference once before starting; skip this step
for manual play:

```sh
bun run inference:setup
```

Open `.doxvelt/inference.json` in your editor, add your endpoint and exact model ID
using the [inference configuration example](#ai-drafts), and save it. Enter any
optional key in the editor, not in a shell command. On Windows PowerShell you can
open the file with:

```powershell
notepad .doxvelt/inference.json
```

Start the API and UI together in one terminal:

```sh
bun run dev
```

Use that same command for every start; no repeated flags or second terminal are
needed. Changes to the file take effect on restart. Without configuration, Stage
explains that generation is not configured and **Perform** remains available.
With configuration, the terminal reports **configured (connection unverified)**:
configuration alone does not test connectivity. Failed generation provides a
bounded authentication/unavailable diagnostic on Stage.

The API listens on `http://127.0.0.1:8787`. The UI uses `http://127.0.0.1:3000`
(or the port selected with `--ui-port`).

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
- Edit, regenerate, and fork accepted history through the CLI or local API without
  destroying its original branch.
- Close episodes to write actor-specific memories and extract beliefs.
- Revise or retract memories on one branch without contaminating siblings.
- Request, inspect, observe failures, and retry causally anchored memory jobs
  through the local API.
- Export and import local simulation packages.

Stage currently supports manual Perform and generated continuation drafts, including
review, complete-whisper regeneration, acceptance, discard and saved-draft recovery.
Editing or regenerating **accepted turns**, and cycling between their alternative
continuations, are not yet available in the shipped Stage UI. Those controls and
browser-local recovery of unsent edits are tracked in [#17](https://github.com/doxvelt/engine/issues/17).
The CLI and local API expose engine capabilities beyond the visual play surface;
the list above is not a list of Stage controls.

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

Configure inference once, then start both processes with `bun run dev`. Manual
Perform works with no configuration and makes no model request.

```sh
bun run inference:setup
# Open .doxvelt/inference.json in your editor, then:
bun run dev
```

Setup exclusively creates an owner-only, ignored `.doxvelt/inference.json` containing
`{}`. It never overwrites an existing file. Replace the empty object in your editor
with your deployment's values, for example:

```json
{
  "baseUrl": "http://127.0.0.1:11434/v1",
  "modelId": "YOUR_EXACT_MODEL_ID",
  "contextWindow": 16384,
  "maxTokens": 768,
  "apiKey": ""
}
```

Enter an optional API key in the editor, keeping it out of shell history. An omitted
or empty key selects the existing keyless transport (which sends a fixed placeholder
Bearer key). Model IDs are opaque and sent exactly as entered, including colons and
quantization suffixes. Configuration is validated locally; **configured does not
mean connection-verified**. Restart `bun run dev` after editing configuration.

This file is plaintext. On POSIX it must be owned by the current user with no group
or other permissions (`chmod 600 .doxvelt/inference.json`); setup creates the directory
with mode 700 and the file with mode 600. Symlink config files are rejected on POSIX.
On Windows, restrict its ACL to your user using Windows file security settings;
POSIX permission checks do not enforce Windows ACLs. Keep the file out of shared
folders, backups and authored content packages. Git ignore is not encryption.

Direct `bun run api` and `bun run dev` use the same resolver, with no home-directory,
workspace, profile or credential-store discovery:

| Setting | Precedence / behavior |
|---|---|
| Config file | `--runtime-config FILE`, otherwise `.doxvelt/inference.json` relative to the launch directory |
| Endpoint/model/sizing | CLI flag > JSON field > sizing defaults (16384 context, 1024 output) |
| API key | Present `DOXVELT_RUNTIME_API_KEY` environment variable > JSON `apiKey`; an explicitly empty environment value forces keyless mode |
| No file | Missing default file means manual-only; an explicitly selected missing file is an error |
| Blank/present file | `{}` means manual-only; incomplete fields, invalid JSON, unknown fields, types, values or unsafe permissions fail startup with values withheld |

The endpoint and model must be configured together. Sizing fields are positive
integers up to 1000000, with output no larger than context. URLs must be HTTP(S)
without embedded credentials, query or fragment. CLI values must be nonempty;
unknown options, missing values and duplicate singleton options are errors. There
is no API-key CLI option. Bun's normal dotenv loading can populate the **API's**
environment; the UI gets an allowlisted environment and an intentionally empty
dotenv file, never the runtime key or configuration file. Ambient Nuxt variables
are intentionally not forwarded by `dev`.

Supported API options (also forwarded by `dev`): `--host`, `--port`, `--db`,
repeatable/comma-separated `--origin`, `--runtime-config`, `--runtime-base-url`,
`--runtime-model`, `--runtime-context-window`, `--runtime-max-tokens`.
`dev` also accepts `--ui-port` (default 3000; API default 8787). It supplies the
matching UI API URL and allowed UI origins. For example:

```sh
bun run dev -- --port 8788 --ui-port 3001 --runtime-max-tokens 512
```

Startup checks that both requested ports can be bound before launching children.
Either child's exit or startup failure stops its sibling. SIGINT and SIGTERM
trigger process-tree cleanup, with a 1.5-second grace period then forced termination
(POSIX process groups; Windows `taskkill /T /F`). Nuxt startup is bounded to 90
seconds, including its first page compilation. Only processes started by this
launcher are targeted.

After a failed request, `GET /runtime` provides a fixed, bounded diagnostic for the
most recent failure in that API process: authentication, unavailable endpoint, or
other provider/configuration failure. Stage shows that diagnostic on failed drafts.
No raw provider body is returned or persisted. After restart, the transient diagnostic
is empty; durable draft failures remain available. Check your configured endpoint,
server availability, key and model locally, then retry. These diagnostics are not
an inference quality or connection-health test.

Configuration, credential paths and credentials never enter authored content,
actor prompts, draft provenance or portable archives. Existing safe provider/model
identity provenance remains portable under its existing policy; IDs that cannot
be represented safely are recorded as unavailable while the exact ID is still used
for inference. The legacy blank scaffold's `models/` metadata is unchanged.

For deterministic startup acceptance (localhost **fixture**, no real-model
verification), first build the UI, then run:

```sh
bun run ui:build
node scripts/verify-inference-startup.ts
```

Use Node >=24. The harness runs the actual `bun run dev`, API and Nuxt through
manual play, authenticated/keyless generation, environment override, restart,
bad-auth/unavailable errors, secret exclusion and shutdown. It keeps logs, the
portable archive and child PIDs under `TMPDIR` and stops its servers. Network/listen
permissions are required. Browser interaction and Windows process/ACL checks
remain separate verification.

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
