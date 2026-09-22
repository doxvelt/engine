# Agent Notes

Doxvelt is a turn-based chat RPG and role-play simulation engine with subjective context, social knowledge, beliefs, memories, affiliations, artifacts, and player-directed turns.

The current code is an early local prototype and executable specification. The target architecture introduces branch-aware event history, memory provenance, a replaceable Pi runtime adapter, capability mediation, and local/hosted deployment parity. Do not assume the current SQLite schema, Vercel AI integration, API routes, or folder boundaries are permanent.

For the narrow approved context and future historical-regeneration supersession,
read [Actor Knowledge](docs/design/ACTOR_KNOWLEDGE.md). Its constraints override
older presence-derived observation and separate historical Accept UI targets;
ordinary continuation acceptance and atomic validation remain.

Read these first:

1. `docs/design/ARCHITECTURE.md`
2. `docs/design/BRANCHING_AND_MEMORY.md`
3. `docs/design/AGENT_RUNTIME.md`
4. `docs/design/UBIQUITOUS_LANGUAGE.md`
5. `docs/design/SUBJECTIVE_CONTEXT_MODEL.md`
6. `docs/design/ENTITY_DOSSIER_FORMAT.md`
7. `docs/design/SYSTEM_LOOP.md`
8. `docs/design/MVP_ARCHITECTURE.md`
9. `docs/design/STAGE_EXPERIENCE.md` for Stage interaction work and reviews
10. [Living Library adoption plan](docs/design/LIVING_LIBRARY_ADOPTION.md) and
    [design-system guidance](design-system/README.md) for Home/Stage adoption work

For the current Home/Stage baseline and selected target, use the Stage Experience
contract and adoption plan; the broad architecture status below predates that work.

## Product Direction

Doxvelt can support entertainment play, education, strategy work, and training simulations. Preserve the hard-turn, subjective-context model across all use cases.

The first maintained product remains a local single-user app with import/export. The architecture must also permit a hosted service without replacing simulation semantics.

Local-first means no hosted Doxvelt account is required. It does not mean host filesystem paths, one-user identity, SQLite types, or synchronous in-process jobs may leak into domain contracts.

## Non-Negotiable Architecture

- One branch contains one singular canonical reality.
- Actor access to that reality is subjective.
- Accepted messages, world events, perceptions, memories, and belief changes are causally linked and immutable.
- Edit, regenerate, and fork create alternate branch paths; they do not mutate accepted history in place.
- Context assembly and retrieval are pure projections at a branch head.
- Generated responses remain drafts until accepted.
- Agent tool effects remain staged in a draft transaction until commit.
- Doxvelt owns simulation semantics, memory validation, and capability authorization.
- The model harness owns provider/model/auth/tool-loop mechanics behind a replaceable port.
- Local and hosted adapters implement the same domain contracts.

Do not introduce simultaneous multi-agent turns in the architectural MVP. Alternative responses belong on sibling branches, not in a reconciliation step.

## Current Implementation

Slices 1 and 2 of the architectural MVP are implemented:

- `src/core`: immutable content revisions, branch-linked commands/events, pure
  projections, stable message perceptions, memory operations, and closure-job
  application services;
- `src/store`: SQLite adapter with atomic branch writes, append-only memory-job
  transitions, detached closure results, and logical schema-v5 import/export;
- `src/ai`: legacy Vercel AI SDK/OpenAI-compatible draft generation, preserved
  until the Slice 3 adapter owns and replaces that path;
- `src/cli`: supported manual play and inspection surface;
- `src/local-api`: supported branch, context, memory-operation, and memory-job API;
- `src/local-ui`: usable Home/Studio authoring surfaces; Stage still targets the obsolete mutation contract;
- `design-system`: canonical product UI language;
- `.github/workflows/ci.yml` and behavior-heavy tests: Linux lint, typecheck, runtime tests, smoke, and production UI build.

Preserve the accepted branch, perception, memory, and portability behavior.
Replace a path only when the next slice owns it; do not maintain parallel
engines.

Known next gaps are:

- runtime-neutral model contracts and deployment-owned runtime profiles;
- a bounded adapter for the validated `pi-ai` `Models` plus
  `pi-agent-core` `Agent` composition;
- staged, authorized Doxvelt capability calls with abort/regenerate isolation;
- migration of Stage to branch/head/command/draft/memory-job contracts;
- a real background worker policy for pending jobs beyond explicit local invocation;
- one-command container packaging and public-readiness documentation;
- migration of authored `models/` endpoint metadata into deployment-owned runtime profiles.

## Design System And Nuxt

The product design system lives in `design-system/`. It contains the static specimen page, canonical visual tokens, fonts, and brand assets.

Use it for UI changes. Preserve Doxvelt-specific semantics for source spans, dossiers, beliefs, access paths, transcript turns, tags, badges, authoring fields, branch state, drafts, and restrained operational states.

Keep Nuxt and Nuxt UI unless a concrete product requirement disproves the choice. Nuxt remains a client or thin BFF, never the domain kernel.

- Keep API contracts outside page components.
- Prefer generated or shared transport types.
- Move API access and orchestration into focused clients, composables, or stores.
- Use Nuxt UI as the canonical component layer; maximize existing Nuxt UI components.
  Extract a Doxvelt Vue component only for recurring, meaningful customization,
  not speculative wrappers: as many components as necessary, as few as possible.
  Native controls require a semantic reason.
- Split large page components when behavior stabilizes and decomposition reduces change risk.
- Do not invent parallel palettes, typography scales, badge semantics, or component treatments without updating the design system.

## Authored Content Versus Runtime

Users author natural-language content packages. They do not author graph atoms directly.

Target local workspace shape:

```text
workspaces/demo/
  runtime-profiles/
  skills/
  worlds/
  scenarios/
  formats/
  entities/
  connections/
```

The current prototype still uses `models/` with endpoint metadata. Migrate that through an explicit content/runtime-profile decision; do not silently preserve credentials or host endpoint configuration as portable world truth.

Each accepted compilation produces an immutable content revision with source spans. A simulation pins its starting content versions. Source edits never silently rewrite an existing branch.

Worlds and scenarios describe objective canonical truth. Subjective context comes from perceptions, entities, connections, beliefs, memories, surfaces, audiences, and access.

## Entity And Belief Model

Initial entity kinds:

- `agent`
- `affiliation`
- `artifact`
- `stateless`

Agents, affiliations, and artifacts can hold beliefs. Stateless entities are invokable generators and do not hold evolving memory unless promoted.

Belief strength:

- `+3`: treats as true
- `+1`: suspects or leans true
- `0`: no stance or neutral
- `-1`: doubts or leans false
- `-3`: treats as false

Characters can confidently believe false things. Never collapse belief into canonical truth.

Belief and memory provenance matters. Losing live access does not erase what an actor perceived or remembered. Current state is projected from branch-valid operations.

Secrets are not a separate content type. They emerge from access and visibility.

## Turns, Perceptions, And Memory

Exactly one actor owns each committed turn. The player normally chooses the next actor.

A turn flows through:

```text
expected branch head
  -> draft transaction
  -> actor context projection
  -> manual or model output
  -> staged capability effects
  -> review/regenerate
  -> atomic accepted commit
  -> actor perceptions
  -> branch-bound memory work
```

Audience and access changes are explicit events. Private conversations are ordinary turns with restricted audience metadata.

Stage whispers are private direction in a draft transaction. They are consumed only by an accepted turn and do not automatically become canonical truth or memory.

Episode closure remains a deliberate memory-consolidation checkpoint. Closed commits are immutable; editing earlier history creates another branch that does not inherit the old closure.

Memory writers propose structured operations. Doxvelt validates and commits them. Agents never receive direct persistence access.

## Agent Runtime And Security

The Pi spike is **VALIDATED**. Implement the first adapter with explicit
`pi-ai` `Models` collections and a fresh low-level `pi-agent-core` `Agent` per
candidate. Do not use `AgentHarness` v2 while its runtime operations remain an
unfinished scaffold, and do not inherit `pi-coding-agent` defaults or resource
discovery.

Prefer `pi-ai` and `pi-agent-core` with:

- Doxvelt-supplied system prompts and actor context;
- in-memory/disposable conversation state;
- explicit curated skills;
- Doxvelt-only capabilities;
- no Pi conversation history as simulation truth;
- no global skill, project-context, shell, filesystem, or network discovery.

Agents do not receive database access, arbitrary host paths, provider credentials, shell/process execution, unrestricted network, or another actor's hidden context.

Side-effecting capability calls execute within a draft transaction. Executable helpers run in sandboxed workers without auth credentials.

Containerization is defense in depth. Capability validation remains the primary authorization boundary.

## Local And Hosted Modes

Local mode may use filesystem content, SQLite, local blobs, in-process jobs, and a local credential store.

Hosted mode may use database/object-storage content, Postgres, a durable queue, runtime/sandbox worker pools, and managed credentials.

The domain engine sees ports and explicit owner scope in either mode. Hosted readiness does not authorize building accounts, collaboration, billing, publishing, or a marketplace during the architectural MVP.

## Implementation Guidance

- Make design decisions explicit before large mechanics.
- Prove immutable manual branches before integrating Pi.
- Keep core behavior behind interfaces, not CLI or HTTP parsing.
- Preserve source spans and human review of compiled prose.
- Keep manual mode as a deterministic test seam.
- Treat imported content and model output as untrusted.
- Use expected-head checks and idempotent command IDs.
- Record provider/model/prompt/skill/tool provenance for accepted runtime artifacts.
- Materialized projections, FTS/vector indexes, caches, and snapshots are rebuildable, not authoritative.
- Prefer focused checks during iteration. Reserve full builds for pre-commit, release/package, or build-affecting changes.
- Do not add `LICENSE`, `CONTRIBUTING.md`, or other social-coding artifacts unless requested.

## Architecture Proof

The first replacement slice must prove:

1. Immutable content revision.
2. Simulation and branch creation.
3. Manual accepted turn commit.
4. Edit and regenerate into sibling branches.
5. Actor context replay at both heads.
6. Branch-relative audience, access, perception, belief, and memory.
7. Pure context queries.
8. No leaked side effects from rejected drafts.

Only after that should Pi, executable skills, retrieval indexes, or hosted adapters expand the surface.
