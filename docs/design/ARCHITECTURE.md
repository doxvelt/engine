# Target Architecture

This document defines Doxvelt's intended long-lived software architecture. It is a target, not a claim about the current implementation.

Doxvelt remains local-first: one person must be able to author and run a simulation without Doxvelt-hosted infrastructure. The same domain model must also support a hosted service without replacing the simulation engine or changing simulation semantics.

## Architectural Position

Doxvelt is an event-sourced simulation engine with subjective actor projections.

- One branch contains one singular canonical reality.
- Actors receive only what they could perceive, believe, remember, retrieve, or access.
- Messages, world events, perceptions, beliefs, and memories are causally linked.
- Edit, regenerate, and fork create new history branches; they never mutate accepted history in place.
- Agents propose actions and memory changes. Doxvelt validates and commits them.
- The model harness is replaceable infrastructure, not the simulation ontology.

## Non-Negotiable Boundaries

1. **Doxvelt owns reality.** The domain kernel owns commands, events, branches, rules, clocks, access, perceptions, and projections.
2. **Doxvelt owns memory.** Character agents and memory writers may propose memory operations; they do not write persistence directly.
3. **The runtime adapter owns model mechanics.** Provider APIs, OAuth, API keys, streaming, reasoning controls, and tool-loop mechanics remain behind an adapter.
4. **Capabilities mediate all agent effects.** Agents receive scoped Doxvelt capabilities, never a database handle or general host access.
5. **Authored content and simulation state remain distinct.** Content packages define starting material. Runtime branches record what happened.
6. **Local and hosted modes share the same domain kernel.** Deployment adapters may differ; semantics may not.

## System Shape

```text
┌──────────────────────────────────────────────────────────────┐
│ Clients                                                      │
│ Nuxt workbench · future desktop shell · hosted web client    │
│ play · author · edit · regenerate · fork · inspect           │
└────────────────────────────┬─────────────────────────────────┘
                             │ typed commands and event streams
┌────────────────────────────▼─────────────────────────────────┐
│ Doxvelt application layer                                   │
│                                                             │
│  Turn coordinator ───────── Simulation domain kernel         │
│          │                         │                          │
│          │                  Event / branch graph             │
│          │                         │                          │
│          ├──── Actor context and epistemic projector         │
│          ├──── Memory service                                │
│          ├──── Content registry                              │
│          └──── Capability broker                             │
└────────────────┬───────────────────────────────┬─────────────┘
                 │ narrow runtime port            │ storage ports
┌────────────────▼────────────────┐       ┌──────▼─────────────┐
│ Agent runtime adapter           │       │ Persistence         │
│ Pi candidate                    │       │ events · blobs       │
│ models · OAuth · tool loop      │       │ indexes · snapshots │
│ prompts · curated skills        │       │ jobs · credentials  │
└────────────────┬────────────────┘       └────────────────────┘
                 │ scoped capability calls
┌────────────────▼────────────────┐
│ Sandboxed execution plane       │
│ ephemeral · limited · no secrets│
└─────────────────────────────────┘
```

These are logical components. The local product should begin as a modular monolith plus isolated agent/tool workers, not as a collection of network services.

## Top Components

### Content Registry

Owns immutable, versioned authored material:

- worlds and scenarios;
- actor and affiliation dossiers;
- relationships and access connections;
- formats and prompt modules;
- curated skill packages;
- assets.

The current prose-first dossier language, lightweight tags, mentions, source spans, and compiler diagnostics remain durable product concepts.

A content package may live in or be exchanged through Git, but a running simulation is not a Git repository. A simulation pins the content versions from which it began. Updating authored source does not silently rewrite an existing branch.

Local adapter:

- filesystem-backed source package;
- import/export directory or archive.

Hosted adapter:

- database metadata plus object storage;
- optional Git-backed authoring or publishing workflow.

### Simulation Domain Kernel

Owns authoritative semantics:

- simulations, branches, and branch heads;
- immutable commands, committed turns, and world events;
- rules and invariant validation;
- clocks, locations, possessions, conditions, and access changes;
- actor perceptions derived from committed events;
- deterministic projections at a selected branch head.

The kernel must not import Nuxt, Pi, a provider SDK, filesystem APIs, or SQLite implementations.

### Turn Coordinator

Coordinates one accepted turn:

1. Resolve a simulation and branch head.
2. Open a draft turn transaction.
3. Select an actor or stateless runtime profile.
4. Assemble the actor's subjective context.
5. Invoke the agent runtime.
6. Stage capability results and proposed events.
7. Validate the completed output and draft transaction.
8. Atomically commit the message, events, and perceptions.
9. Schedule or perform branch-bound memory work.

Generated drafts are disposable. Accepted turns are immutable. Editing an accepted turn creates another branch.

### Actor Context And Epistemic Projector

Builds an actor-neutral `ActorContext` for one actor at one branch head from:

- actor constitution and active agenda;
- accessible world and scenario material;
- directly perceived events;
- claims received from other actors;
- current and historical beliefs with provenance;
- relationship state and access paths;
- branch-valid memories;
- relevant projected surfaces;
- accessible transcript material;
- current audience and private direction;
- curated skills and capabilities.

Context assembly should be pure. Reading context must not create first impressions, memories, beliefs, or other state. Such effects are committed from explicit perception or memory operations.

### Memory Service

Owns branch-aware memory operations, projection, retrieval, and consolidation.

Memory is actor-subjective and source-bound. It may be inaccurate without becoming untraceable. Details live in [Branching and Memory](BRANCHING_AND_MEMORY.md).

### Agent Runtime Gateway

Exposes a provider-neutral Doxvelt port for:

- text or structured generation;
- streaming runtime events;
- provider and model selection;
- OAuth and API-key resolution;
- tool loops;
- curated skill discovery;
- usage, cost, and model metadata.

The bounded spike validated explicit `pi-ai` `Models` collections plus a fresh
low-level `pi-agent-core` `Agent` per candidate as the first adapter composition.
Do not use the unfinished `AgentHarness` v2 or inherit `pi-coding-agent` defaults.
Doxvelt domain types must not depend on Pi types.

See [Agent Runtime and Security](AGENT_RUNTIME.md).

### Capability Broker

The only doorway from an agent into Doxvelt.

Each capability call is scoped to:

- owner or tenant scope;
- simulation;
- active branch head;
- actor;
- draft turn transaction;
- explicit capability grant.

Capabilities return actor-appropriate information and stage mutations inside the draft transaction. They never expose persistence primitives.

### Persistence And Derived Indexes

Doxvelt uses ports for:

- simulation event storage;
- authored content storage;
- projection snapshots;
- blobs and generated media;
- memory text and vector/FTS indexes;
- background jobs;
- credentials and provider-account references.

Only immutable domain events and content versions are authoritative. Materialized views, vectors, FTS tables, prompt caches, and snapshots must be rebuildable.

## Deployment Modes

### Local

```text
Nuxt workbench
Doxvelt API/application process
Pi runtime worker
optional sandbox workers
SQLite event store
local content and blob directories
in-process or SQLite-backed jobs
local credential store
```

Local mode requires no Doxvelt account and may use local or hosted models.

### Hosted

```text
Nuxt web client / thin BFF
stateless Doxvelt API instances
agent runtime worker pool
sandbox worker pool
Postgres event and projection store
object storage
job queue
managed credential store
observability and quota services
```

Hosted readiness does not mean implementing accounts, billing, collaboration, or a marketplace in the first reset. It means avoiding local-only assumptions in domain contracts:

- use globally unique IDs rather than process-local integer identity;
- carry explicit ownership or tenant scope at the application boundary;
- never accept arbitrary host filesystem paths from remote clients;
- keep source, event, blob, job, and credential storage behind ports;
- make commands idempotent and concurrency-aware;
- treat provider credentials as user or organization resources, not world content;
- keep long-running generation and memory work resumable and observable.

## UI And API Stance

### Nuxt

Keep Nuxt and Nuxt UI as the preferred workbench frontend unless a concrete product requirement disproves the choice.

Reasons:

- Michael can still review framework usage, component consistency, and inefficient agent output;
- the existing design system and Nuxt UI integration are useful assets;
- Nuxt supports local web, hosted web, and possible desktop-shell packaging;
- replacing a competent frontend would not solve the runtime architecture problem.

Guardrails:

- Nuxt is a client or thin BFF, not the domain kernel;
- domain and API contracts live outside Vue components;
- generated/shared contract types replace page-local copies;
- API access, orchestration, and state move into focused composables or stores;
- Nuxt UI remains the canonical component layer, with native controls used only when semantically justified;
- large page components should be decomposed as behavior stabilizes.

### API

The API is an application boundary over commands, queries, and streams. Its framework is not yet a domain decision.

The current local HTTP API proves the sibling-wrapper shape but is not hosted-ready: it accepts filesystem paths, has permissive CORS, no ownership/auth scope, hand-written request validation, and synchronous local-store assumptions. Preserve its demonstrated use cases, not necessarily its implementation.

## Security Model

Containerization is defense in depth, not the primary authorization system.

- The trusted runtime/auth process may hold provider credentials but receives no general-purpose host tools.
- Executable skills and untrusted tools run in isolated workers without provider credentials.
- Sandboxes use read-only roots, ephemeral scratch space, resource limits, denied network by default, and narrow RPC to the Capability Broker.
- No sandbox receives the host home directory, database file, credential store, or container socket.
- Skill retrieval is by approved ID and version, not filesystem browsing.
- Memory writing is a structured proposal validated by the Memory Service, not direct storage access.

## Current Implementation Assessment

The present code is a prototype and executable specification, not a contractual architecture.

Preserve or port:

- prose-first content compilation and diagnostics;
- source spans;
- entity, belief, provenance, audience, access, and surface concepts;
- hard-turn interaction;
- manual generation mode;
- import/export behavior;
- domain-focused tests;
- Nuxt workbench and Doxvelt design system.

Replace or deeply refactor:

- linear transcript and episode tables as canonical history;
- direct `RuntimeStore`/SQLite coupling in core functions;
- state changes triggered from context reads;
- non-transactional episode closure and memory persistence;
- Vercel-specific generation implementation;
- provider credentials and endpoint details treated as portable world source;
- direct filesystem paths crossing a remotely accessible API;
- large UI pages containing duplicated contracts and orchestration logic.

Do not delete the current implementation before replacement behavior is covered. Sunk cost is irrelevant; retained tests and observed semantics are evidence.

## Codebase Shape

Begin with logical module boundaries inside the existing repository. Split workspace packages only when boundaries need independent dependencies or execution:

```text
apps/
  web/                 Nuxt workbench
  api/                 command/query/stream boundary
  worker/              trusted agent runtime worker
packages/
  domain/              events, rules, branch semantics, projections
  application/         coordinators and use cases
  contracts/           typed external and runtime contracts
  content/             source compiler and content registry
  memory/              memory operations and retrieval
  agent-runtime/       runtime port and Pi adapter
  persistence/         local adapters; hosted adapters later
  capability-broker/   scoped tools and draft transactions
```

This is a target map, not a request to move files before behavior and boundaries are proven.

## Architectural Tests

The architecture is succeeding when:

- two actors receive observably different contexts from one committed reality;
- a mistaken belief survives and changes later behavior;
- edit, regenerate, and fork produce isolated branch projections;
- memory revisions disappear from a replacement branch while remaining auditable on the old branch;
- no runtime adapter can mutate canonical state outside a draft transaction;
- the same domain test suite runs against local and hosted persistence adapters;
- changing model provider or harness does not migrate simulation state;
- the Nuxt client can point at local or hosted APIs without changing simulation semantics.
