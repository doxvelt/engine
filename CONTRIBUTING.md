# Contributing

Use Node.js >=24 and Bun 1.3.13 (or compatible). Run `bun install` from the
repository root. Read [AGENTS.md](AGENTS.md) and its required design contracts
before engineering changes. Design documents describe targets as well as shipped
behavior; inspect current source and tests before claiming a feature.

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


See the [CLI/runtime/security reference](docs/LOCAL_REFERENCE.md) for deployment
configuration and command examples.

## Startup acceptance harness

Run `node scripts/verify-inference-startup.ts` with Node >=24 and Bun on PATH
from a source folder (ZIP extraction or checkout) with dependencies already installed. No UI build is required.
CI runs this after the unchanged package checks and production UI build.

The harness traverses `src`, `scripts`, `examples` and `design-system`, plus
`package.json` and `tsconfig.json`, copying allowed source/config/asset file types
including untracked source into a writable temp launch directory. Git is not required.
It excludes hidden metadata, dotenv, inference configuration, runtime state, databases,
secret/key files, build/cache directories and symlinks; it never follows source links. It links installed packages into a separate node_modules
directory, keeping writable caches local. It starts `bun start` without an inference
file, explicit config path, or prebuilt `.nuxt`/`.output` files. Runtime state,
configuration, home/cache/temp directories, logs, archives and child PIDs stay under
the reported temp evidence root; existing worktree state is not used or changed.

It checks the displayed URL/config guidance, automatic full blank private profile,
unconfigured runtime, Home's example entry and a manual turn persisting across
restart, including unchanged configuration bytes. Requests drive the same example
API used by Home, and fetch the real Home/Stage pages; this is not browser-click
acceptance. Subsequent launches cover authenticated/keyless synthetic generation,
exact CLI model override with a custom config, environment key precedence,
connection-unverified startup, safe diagnostics, secret exclusion and shutdown.
The occupied-port check preserves the unrelated listener.

Network/listen permissions are required. The harness stops its servers and leaves
evidence under TMPDIR. Fixture replies are deterministic synthetic output, not
real-model quality or connectivity verification. Focused tests inject hard-link
failures; they do not prove behavior on a real exFAT filesystem. Browser and Windows ACL/process
validation remain separate. The app does not install or provide a model server.
