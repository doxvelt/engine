# MVP Architecture

This document defines the smallest implementation slice that can validate the target architecture in [Target Architecture](ARCHITECTURE.md).

The current repository already contains a working local prototype. The next implementation phase may replace substantial runtime code. It should preserve proven product concepts and tests rather than either defending or deleting code because it already exists.

## MVP Outcome

The architectural MVP proves this complete loop:

```text
versioned content
  -> simulation and branch
  -> actor-specific context at a branch head
  -> manual or Pi-backed draft
  -> staged capability effects
  -> accepted immutable turn commit
  -> subjective perceptions and branch-aware memory
  -> edit/regenerate/fork with isolated projections
```

A successful slice should be playable through the local workbench and portable through import/export. It should not require Doxvelt-hosted infrastructure.

## Product Position

Doxvelt is local-first, not local-only.

The first maintained experience remains a local single-user workbench. Hosted readiness is an architectural constraint rather than an MVP feature.

MVP decisions assume:

- one active local user;
- local content packages;
- SQLite persistence;
- manual and model-backed turns;
- import/export as the first sharing boundary;
- no required Doxvelt account;
- no real-time collaboration, billing, marketplace, or publishing service.

MVP contracts must nevertheless avoid assumptions that would force a new domain engine for hosted use:

- explicit owner scope at application boundaries;
- globally portable IDs;
- storage ports rather than filesystem or SQLite types in the domain;
- branch-head concurrency and idempotent commands;
- credential references outside content packages;
- resumable generation and memory jobs;
- no arbitrary host paths in remotely usable commands.

## Technology Stance

### TypeScript

Keep TypeScript across domain, application, API, runtime adapter, and frontend. Pi and Nuxt fit this ecosystem, and a language split would add lifecycle cost without solving a demonstrated problem.

### Nuxt

Keep Nuxt and Nuxt UI for the workbench.

The existing Home, Studio, and Stage product surfaces and Doxvelt design system should survive. Runtime replacement should occur behind typed API contracts.

Refactor UI structure only as required:

- generated or shared transport types;
- focused API client and composables/stores;
- smaller components when current pages impede change;
- Nuxt UI as the canonical component layer.

Do not rewrite the frontend merely because the runtime changes.

### Pi

Use Pi only after the spike in [Agent Runtime and Security](AGENT_RUNTIME.md) passes.

Preferred composition:

- `@earendil-works/pi-ai` for providers, models, OAuth, and API-key auth;
- `@earendil-works/pi-agent-core` for the agent loop and runtime events;
- Doxvelt-supplied system prompts, contexts, skills, and capabilities;
- in-memory/disposable conversational state.

Do not adopt Pi's coding-agent session history as simulation history.

### Persistence

Use SQLite for the first event store and derived projections. Define contracts that a hosted Postgres adapter can implement later.

SQLite is an adapter, not the `RuntimeStore` type imported throughout core semantics.

## Logical Modules

The MVP may remain one repository and initially one package. These boundaries should exist in code regardless of folder layout:

```text
content
  source loading, compilation, versions, source spans

domain
  simulations, branches, commits, events, invariants

application
  commands, queries, turn coordinator, draft acceptance

projection
  canonical world, audience/access, actor epistemic context

memory
  memory operations, projection, retrieval, closure

agent-runtime
  runtime port, manual adapter, Pi adapter

capabilities
  authorization, draft transaction tools, sandbox bridge

persistence
  SQLite implementations, blobs, indexes, jobs

interfaces
  CLI, API, Nuxt workbench
```

The domain and application modules must not import concrete SQLite, filesystem, Nuxt, Pi, or provider SDK implementations.

## Implementation Slices

### Slice 1: Immutable Manual Branches

Prove the branch model without any LLM:

1. Import or compile one content package into an immutable content version.
2. Create a simulation, default branch, and initial head.
3. Commit manual player and actor turns.
4. Build actor context by replaying/projecting one branch head.
5. Edit a previous message into a sibling branch.
6. Regenerate a manual actor response into another sibling branch.
7. Fork from a selected commit.
8. Verify audience, access, beliefs, and first impressions are branch-relative.

This slice is the hard gate. Do not integrate Pi first.

### Slice 2: Memory And Closure

1. Add branch-bound memory operations.
2. Close an episode as an immutable branch checkpoint.
3. Generate deterministic memory proposals from actor perceptions.
4. Revise or retract a memory on one branch.
5. Verify another branch retains its own projection.
6. Verify late or retried memory work attaches only to its originating closure.

### Slice 3: Pi Runtime Adapter

1. Run one actor turn through an OAuth-backed model.
2. Run the same contract through an API-key or local model.
3. Supply context entirely from Doxvelt.
4. Expose one read capability and one staged mutating capability.
5. Abort and regenerate without leaked effects.
6. Record runtime and skill provenance.
7. Demonstrate that no shell, filesystem, database, credential, or unrestricted network access reaches the actor.

### Slice 4: Workbench Migration

Update the existing Nuxt Stage surface to:

- display branches and current head;
- distinguish generated drafts from accepted turns;
- edit, regenerate, and fork;
- inspect subjective context at selected heads;
- display branch-aware memories and beliefs;
- expose job/runtime failure without corrupting history.

Studio remains the prose-first content authoring surface.

## Current Prototype Disposition

### Preserve Or Port

| Area | Reason |
|---|---|
| Source compiler and source spans | Core authoring value and strong acceptance tests |
| Entity kinds, beliefs, provenance, surfaces, access links | Durable subjective-context language |
| Audience and restricted-turn behavior | Correct social visibility concept |
| Hard-turn flow and manual generation | Deterministic test seam |
| Import/export intent | Local-first portability boundary |
| Nuxt design system and workbench surfaces | Product learning independent of runtime storage |
| Domain behavior tests | Executable evidence of intended semantics |

### Replace Or Deeply Refactor

| Area | Reason |
|---|---|
| Linear transcript and episode tables | No causal branches or message versions |
| Destructive simulation reset | Erases rather than branches history |
| Direct SQLite `RuntimeStore` imports in core | Prevents real adapter boundary |
| Context reads that persist first impressions | Queries must not mutate reality |
| Blocking, non-transactional episode closure | Can leave partial memory/belief state |
| Vercel AI SDK implementation | Does not provide desired OAuth/tool/skill harness |
| Provider endpoint/env configuration in portable source | Credentials and deployment policy are not world content |
| Arbitrary filesystem paths across the API | Local convenience becomes hosted vulnerability |
| Duplicated page-local API/domain types | Contracts will drift as branch semantics evolve |

Do not delete prototype code in a preparatory purge. Replace behavior slice by slice and use Git history plus acceptance tests as evidence. Once a replacement owns a path, remove the obsolete implementation rather than maintaining parallel engines.

## Import And Export

A portable package must be logical, not a blind copy of one database implementation.

It includes:

- manifest and schema versions;
- pinned authored content and assets;
- simulation metadata;
- branches, commits, events, perceptions, and memory operations;
- runtime artifact provenance where portable;
- optional generated media.

It excludes:

- raw provider credentials;
- host paths;
- local auth state;
- disposable indexes, caches, and snapshots;
- sandbox scratch data.

Local implementations may optimize export internally, but the package contract cannot be `runtime.sqlite` forever if hosted portability matters.

## API Shape

Commands carry expected branch head and idempotency identity:

```ts
type CommandEnvelope<T> = {
  ownerScope: string;
  simulationId: string;
  branchId: string;
  expectedHead: string;
  commandId: string;
  payload: T;
};
```

Queries identify the branch head they project:

```ts
type ProjectionQuery = {
  ownerScope: string;
  simulationId: string;
  branchId: string;
  head?: string;
};
```

The local API may supply the single local owner implicitly. Hosted mode resolves it from authentication. The domain receives an explicit scope either way.

Generated drafts and committed turns use different commands. A model result does not become reality merely because generation completed.

## Verification Gates

The architecture MVP is complete when automated tests prove:

- manual branches replay to isolated canonical states;
- edit, regenerate, and fork retain old paths without contaminating new ones;
- context queries are pure;
- actors receive only branch-valid perceptions and memories;
- memory revisions follow causal ancestry;
- accepted turns commit atomically with staged effects;
- rejected or aborted drafts leak no effects;
- model/auth/runtime changes do not alter simulation storage;
- local import/export preserves branch and memory semantics;
- Nuxt can operate against the new API without containing domain rules.

## Non-Goals

Do not build these during the architectural MVP:

- simultaneous multi-agent turns;
- autonomous actor scheduling;
- hosted accounts or organization administration;
- billing or usage monetization;
- real-time collaborative authoring;
- public publishing or marketplace;
- general-purpose plugins;
- custom inference or provider protocols;
- arbitrary agent filesystem or shell access;
- perfect semantic memory retrieval;
- migration support for unreleased prototype runtime databases.

The MVP proves Doxvelt's distinctive claim: one committed reality per branch, projected into genuinely different subjective lives that remain coherent under revision.
