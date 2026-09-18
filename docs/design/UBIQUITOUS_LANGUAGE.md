# Ubiquitous Language

This glossary captures the product language for Doxvelt, a chat-like RPG and role-play simulation engine built around subjective context.

## Agent

An entity that can take turns, act in the simulation, hold beliefs, and write memories.

Example: Jade, Luke, Mike, Pete.

## Affiliation

An entity that represents a group, institution, faction, or collective. It can hold beliefs and grant access to those beliefs through membership-like connections.

Example: Police Unit, Mafia, Inner Circle.

## Artifact

An entity that can hold beliefs or belief-bearing contents without acting like a character.

Example: Luke's phone, a diary, a ledger, a case file.

## Belief

A holder-specific stance toward a proposition. Beliefs may be true, false, conflicted, stale, source-linked, or based on poor evidence.

MVP strength scale:

- `+3`: treats as true
- `+1`: suspects or leans true
- `0`: no stance or neutral
- `-1`: doubts or leans false
- `-3`: treats as false

## Belief Event

A provenance record describing how a belief entered or changed in a holder's context.

Examples: held, accessed through membership, retained after access loss, observed, told, inferred, briefed, read, stolen, generated, joined.

## Belief Provenance

The source path that explains why a belief is present in an actor's current context.

Provenance does not mean the actor personally owns or trusts the belief. A belief held by an affiliation can be accessible to a member while still remaining the affiliation's belief.

## Branch

One possible line of simulation history. A branch inherits immutable commits from its ancestors and points to one current head.

Several branches may be preserved, but only the selected branch defines canonical reality for that play path.

## Branch Head

The latest commit selected for a branch. Commands carry an expected head so stale clients cannot append to or mutate the wrong history silently.

## Capability

A typed, scoped operation an agent runtime may request through Doxvelt.

Capabilities express simulation verbs such as observing, recalling, inspecting known material, or attempting an action. They do not expose host infrastructure.

## Retained Belief

A weakened belief an actor keeps after losing access to a belief source.

Retained beliefs are not live access. They are the actor's stale or memory-shaped stance after the access path is gone.

## Belief Holder

An entity capable of holding beliefs. For MVP, agents, affiliations, and artifacts are belief holders.

## Canonical Truth

Objective truth on one simulation branch at one head. Canonical truth may be hidden from author UI or unknown to characters, but it is represented by committed events and projections in that branch.

## Command

A request to change simulation state. Commands are validated against an expected branch head and produce zero or more immutable events when accepted.

## Commit

An immutable causal node containing an accepted message and/or domain events, perceptions, provenance, and branch-bound operations. Commits link to a parent commit.

## Connection

An authored link between entities. Connections cover relationships, memberships, bonds, rivalries, ownership, access, and similar links.

Some connections have engine-recognized mechanics. Membership is the most important MVP example.

## Context Assembly

The pure process of constructing temporary prompt context for one actor at one branch head from accessible beliefs, affiliations, memories, perceptions, surfaces, artifacts, scenario context, skills, capabilities, and format.

## Draft Turn Transaction

An isolated container for generated text, capability results, random outcomes, and proposed events before a turn is accepted. Rejecting or regenerating discards the draft without changing canonical reality.

## Entity

An object in the simulation source or runtime. For MVP, entity kinds are fixed:

- `agent`
- `affiliation`
- `artifact`
- `stateless`

## Episode Memory

A branch-bound prose memory proposed from an actor's subjective perceptions at episode closure. Episode memories are searchable but not necessarily injected into every turn.

## First Impression

A belief generated when an observer first encounters an entity through an observation channel. First impressions are derived from projected surfaces and should carry meaningful weight.

## Format

The output schema a turn should follow.

Example: screenplay format with actions in asterisks and dialogue without quotes.

## Long-Term Memory

A memory whose branch-valid operation history gives it durable influence on future behavior. It may be asserted, revised, consolidated, or retracted without erasing its provenance.

## Memory Operation

An immutable assertion, revision, consolidation, or retraction of actor memory, tied to source perceptions and causal history. Current memory is a projection of operations at a branch head.

## Membership

A connection capability that grants access to another entity's beliefs during context assembly.

Membership can be nested and transitive downward. It does not automatically push child beliefs upward.

## Model

An abstract language or multimodal model available through an agent runtime. Authored content may express model intent or reference a runtime profile; provider credentials and deployment endpoints do not belong to portable simulation truth.

## Observation Channel

A modality through which projected surface can be observed.

MVP channels:

- `in_person`
- `text`
- `image`
- `audio`
- `video`
- `@artifact`

## Perception

The actor-specific result of a committed event becoming observable through audience, access, location, channel, or another rule. Memory and belief changes attach to perceptions rather than automatically to omniscient events.

## Projection

Derived state calculated from immutable source versions and branch ancestry. Canonical world state, actor context, current beliefs, and active memories are projections rather than separately authored truth.

## Projected Surface

Default outward presentation an entity makes available to observers under normal conditions.

Projected surface is not inner state. Both can contradict and still be true.

Example: Jade is nervous internally, but usually appears calm.

## Proposition

A claim about the world that can have canonical truth and holder-specific beliefs.

Example: Mike loves Jade.

## Scenario

The objective starting situation for a simulation or game. Scenarios live next to entities and connections on disk as unstructured Markdown.

Examples: Jade, Mike, Luke, and Pete meet in a cabin in the woods. A student team interviews the CEO, COO, and CFO of a troubled company. A crisis team coordinates an Apollo 13-style response under partial information.

Scenarios describe canonical truth only.

## Runtime Artifact

A generated draft, accepted output, summary, embedding, tool result, or other model-produced artifact with runtime provenance. Not every runtime artifact is committed simulation state.

## Runtime Profile

A versioned policy selecting system-prompt composition, model intent, reasoning budget, skills, memory retrieval, capabilities, output schema, and runtime limits for an actor or system role. Credentials are resolved separately.

## Source Revision

An immutable version of compiled authored content used as starting input to a simulation. Editing source creates a new revision; it does not silently rewrite existing branches.

## Stateless Invokable Entity

A model-powered generator or assistant that can be invoked but does not hold evolving beliefs or memories. Stateless actors are a special entity kind and can use unstructured Markdown dossiers.

Example: Fate, scene heading generator, complication generator.

## Stage Whisper

Private player direction for one actor's draft, hidden from other actors, consumed
only on acceptance and not automatically canonical truth or memory. **Stage whisper** is the selected UI
name for the current **Direct** mode; **Generate draft** is its action. **Original
stage whisper** identifies the originating instruction, separately from the
resulting draft performance. Refinement edits the latest **complete stage whisper**
and generates afresh at the same pre-turn context; prior whispers/performances
remain provenance, not model input. Legacy additive corrections are not silently
converted into complete whispers. Proposed-audience generation requires the contract
gates in [Stage Experience](STAGE_EXPERIENCE.md).

## Turn

One actor's accepted contribution and associated effects in the growing branch history. Doxvelt uses hard turns: exactly one actor owns each committed turn. Generated drafts are not turns until accepted.

## Workspace

A local authoring adapter for one Doxvelt content package. It contains worlds, scenarios, formats, entities, connections, skills or runtime-profile references, and assets.

Example layout:

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

A workspace is not itself a world or simulation. It may contain one or more world files, scenarios, and reusable assets. Hosted authoring may store the same logical content package without representing it as a host filesystem folder.

## World

Immutable laws and norms that govern the simulation or RPG. Worlds live next to entities and connections on disk as unstructured Markdown.

Examples: physics, social norms, legislative laws, genre constraints, market structure, company governance, training exercise rules.

Worlds describe canonical truth only.

## Stage UI terms

These labels describe interaction; they do not rename domain records. See
[Stage Experience](STAGE_EXPERIENCE.md) for implementation status and gates.

- **Perform:** submit manually authored actor words/actions. Current Stage commits
  immediately; a separate manual preview remains undecided.
- **Draft performance:** proposed output awaiting acceptance, distinct from private
  direction and accepted history.
- **Actor / Audience:** one acting identity and the explicit whole-turn recipients.
  Optional `#actor` / `@audience` notation is selected direction, not shipped grammar.
  Plain names never route; sender-own perception remains independent.
- **Continue:** the selected return action for resuming an existing simulation.
- **Actor state:** the selected label for target runtime-state inspection; historical
  timing and authorization remain gated. Current Stage exposes safe identity only.
- **Production:** candidate UI wording for a running simulation, not an approved
  domain, schema or API rename. A simulation descends from pinned authored content;
  a branch selects one history path within it.
