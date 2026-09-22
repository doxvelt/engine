# Branching And Memory

> Approved correction: [Actor Knowledge](ACTOR_KNOWLEDGE.md) supersedes older
> presence-derived observation and selective-context targets. All legitimate
> branch-relative knowledge is supplied upfront; outgoing recipients grant no
> observation. Legacy saved policies keep their exact interpretation.
> For future historical regeneration, validated generation and safe commit
> create/select an alternative immediately, with no separate Accept UI. Alternatives
> cycle at the branching turn and preserve their continuations. Older historical
> draft/Accept and sibling-acceptance gates below are superseded; ordinary
> continuation Accept and manual editing are unchanged. Blanket effectful-turn
> blocking was a recommendation, not approved policy; unsupported cases stay gated.
> Sequence: #32 context, then #17 saved alternatives engine/API, then UI recovery
> and cycling. Cleanup #33 remains separate with semantics undecided.

This document defines how Doxvelt preserves causality when a player edits a message, regenerates a response, forks a simulation, or changes memory-producing history.

## Core Rule

Doxvelt never edits accepted history in place.

The UI may present familiar operations such as edit, regenerate, delete, undo, or fork. The storage model represents them as immutable alternatives in an event tree.

One selected branch contains one singular canonical reality. The repository may preserve several possible branches without treating them as simultaneously true.

## Core Records

### Simulation

A simulation is one runtime descended from pinned authored content versions.

### Branch

A branch identifies a named or implicit line of history and points to one current head.

### Commit

A commit is an immutable causal node. It may contain:

- an accepted player or actor message;
- world events;
- audience and access changes;
- actor perceptions derived from those events;
- closure or checkpoint events;
- branch-bound memory operations;
- provenance and runtime metadata.

Commits link to a parent commit. A new child from an earlier parent creates an alternate path.

### Message And Message Version

A logical message may have several immutable versions. Branch history references a specific version ID, never only the logical message ID.

### Draft Turn Transaction

A draft transaction contains generated text, staged capability results, random outcomes, proposed world events, and memory proposals before acceptance.

Drafts are not canonical history. Accepting a draft atomically creates a commit. Rejecting or regenerating discards the draft.

## Edit, Regenerate, And Fork

### Edit

Editing an accepted message:

1. Selects the parent commit before that message.
2. Creates a new message version.
3. Creates a new child commit from the selected parent.
4. Continues on a new branch path.

Downstream messages, events, perceptions, memories, and belief revisions from the old path remain intact but are not visible from the new branch head.

### Regenerate

Regenerating an actor response creates another draft and, if accepted, another child of the same input commit.

The original response remains available on its original path. New tool outcomes, world events, and memory effects belong only to the regenerated path.

### Fork

Forking creates a new branch reference at a selected commit.

The fork inherits all ancestor events and projected state. Events and memories produced after the fork point remain branch-local.

### Delete

Deleting from the active story normally means moving the active branch head or creating a replacement path. Physical deletion is a later garbage-collection concern and must respect export, audit, retention, and privacy policy.

## Memory Model

Memory is synchronized to committed perceptions and events—not merely to transcript text.

A character may remember:

- something directly experienced;
- something another actor claimed;
- an inference drawn from available evidence;
- a mistaken interpretation;
- an emotional or relational meaning;
- a stale belief retained after access loss.

The content may be wrong. Its provenance may not be absent.

### Memory Operations

Memory state is projected from immutable operations:

```text
memory_asserted
memory_revised
memory_retracted
memory_consolidated
```

Each operation records at least:

- operation ID;
- actor ID;
- memory identity or subject;
- memory kind;
- structured content plus optional prose rendering;
- source perception, event, and message-version IDs;
- producing commit or closure ID;
- branch ancestry;
- confidence or importance where applicable;
- runtime profile, model, prompt, schema, and skill versions;
- creation time.

A revision points to the memory state it revises. A retraction does not erase history.

### Branch Projection

The actor's current memory state is calculated at a branch head.

Example:

```text
ancestor
  memory_asserted: Norji believes Mike is avoiding command

old branch
  memory_revised: Norji believes Mike is afraid of being selected

edited branch
  old revision is not an ancestor
  the earlier belief remains current until this branch changes it
```

No special cleanup is required when history changes. The old memory operations remain reachable only from the old branch.

### Retrieval

Retrieval must be branch-aware and actor-scoped.

A retrieval request carries:

- owner or tenant scope;
- simulation ID;
- branch head;
- actor ID;
- query or current context;
- allowed memory kinds;
- budget and ranking policy.

FTS and vector stores are derived indexes. They may contain records from many branches, but returned results must be filtered against the active memory projection before entering actor context.

### Episode Closure And Consolidation

Episode closure remains useful as a deliberate narrative and memory-consolidation boundary. It is no longer a linear-history lock.

Closing an episode may:

- mark a branch checkpoint;
- generate episode memories from each actor's branch-valid perceptions;
- revise or consolidate long-term memories;
- extract subjective beliefs;
- schedule embeddings and summaries.

A closed episode commit is immutable. Editing history before it creates another branch that does not inherit the old closure or its memory operations. The original closed branch remains valid and inspectable.

Closure work may initially remain blocking for a simple local product. The target contract must also support queued execution:

- closure request committed;
- memory jobs carry the closure commit and branch head they belong to;
- results attach only to that causal node;
- moving the active branch does not misapply late results;
- partial failure is visible and retryable.

## Perception Before Memory

Canonical events do not enter memory directly.

```text
canonical event
  -> actor-specific perception
  -> memory proposal
  -> validated memory operation
```

An actor absent from a conversation receives no perception and therefore no memory. If another actor later reports what happened, the receiving actor may remember the report—not retroactively observe the original event.

This preserves the distinction between:

- what happened;
- what was observable;
- what an actor perceived;
- what an actor concluded;
- what an actor later remembered.

## Memory Writers

A character actor or separate memory-writer runtime may propose memories. Neither writes storage directly.

A proposal is validated for:

- actor identity;
- active simulation and branch;
- valid source perceptions;
- schema and size;
- allowed memory kind;
- capability grant;
- causal attachment to the producing transaction or closure.

Player review may be added as a product option without changing persistence semantics.

## Transactions And Tool Effects

Every side-effecting capability used during generation executes against the current draft turn transaction.

The model may need several observations and actions before producing final text. Those staged results remain isolated until acceptance.

On acceptance:

```text
message version
+ staged world events
+ derived perceptions
+ audience/access effects
+ provenance
= one atomic commit
```

On abort or regeneration, the draft is discarded. External irreversible side effects are not ordinary actor capabilities and require a separately disclosed integration contract.

## Determinism And Reuse

LLM outputs need not be reproducible. They must be preservable.

Doxvelt records enough runtime metadata to explain an artifact:

- runtime adapter and version;
- provider and model;
- prompt/context hash;
- relevant content and skill versions;
- tool calls and results;
- structured-output schema;
- generation and memory job IDs.

Artifacts before the common ancestor are reused. Downstream projections are recalculated or loaded from branch-head-keyed checkpoints. Identical derived jobs may be reused by content hash, but caches are never authoritative.

## Storage Guidance

The initial local event store may use SQLite. A hosted adapter may use Postgres. Both implement the same branch and projection contracts.

Use globally unique stable IDs for domain identity. Local integer sequences may remain internal storage details but must not be exposed as portable causal identity.

Recommended authoritative categories:

```text
simulations
content_versions
branches
commits
message_versions
domain_events
actor_perceptions
memory_operations
runtime_artifacts
job_records
```

Recommended derived categories:

```text
current world projections
actor epistemic projections
active memory projections
FTS/vector indexes
prompt caches
branch checkpoints
usage summaries
```

## Required Behavioral Tests

1. Editing a player message creates a sibling history; the original path remains readable.
2. Regenerating an actor response does not reuse its old world mutations.
3. Forks inherit ancestor memories and exclude memories created after the fork point.
4. A memory revision on an abandoned branch does not affect the replacement branch.
5. An absent actor cannot retrieve a memory derived from an unperceived event.
6. A late memory job attaches to its original closure even after the active head moves.
7. Context assembly and memory retrieval never mutate simulation state.
8. Local and hosted stores produce equivalent projections for the same event history.
