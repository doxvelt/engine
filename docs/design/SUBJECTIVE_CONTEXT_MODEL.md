# Subjective Context Model

This document captures the conceptual runtime model for Doxvelt, a chat-like RPG and role-play simulation engine with multiple agents, affiliations, artifacts, secrets, mistaken beliefs, and emerging social dynamics.

The core design principle:

> Canonical reality is singular, but access to it is subjective.

Characters do not all receive the same world state. Each actor's turn context is assembled from the beliefs, memories, affiliations, artifacts, surfaces, and connection fabric available to that actor at that moment.

## Layers

The system has three distinct layers.

1. Authored source
   - Natural-language dossiers and connection files.
   - Human-friendly source of the initial simulation state.
   - Uses lightweight mentions and line tags to aid compilation.

2. Runtime fabric
   - Compiled entities, connections, propositions, beliefs, events, surfaces, and memories.
   - Not edited directly by users in MVP.
   - Can preserve source spans back to dossier prose.

3. Turn context
   - Temporary prompt context constructed for one actor's turn.
   - Includes only what the actor can currently access or retrieve.

## Entities

For MVP, entities have a fixed kind:

- `agent`
- `affiliation`
- `artifact`
- `stateless`

Agents, affiliations, and artifacts can be belief holders. Stateless entities are invokable actors or generators that do not hold evolving beliefs or memories. A locked door is not an entity; a belief-holding artifact locked behind the door may be.

Entities may have optional projected surfaces. They may also be members of other entities when the membership is sane for the scenario.

Examples:

- Jade is an `agent`.
- Police Unit is an `affiliation`.
- Luke's phone is an `artifact`.
- Fate is a `stateless` entity.
- Inner Circle is an `affiliation` and may be a member of Mafia.
- Luke's phone may be a member of Mafia if it carries Mafia-held knowledge.

## Connections

Authored relationships, memberships, bonds, rivalries, ownership, and access links are all modeled as connections.

At runtime, a connection may have recognized mechanics. The most important one for MVP is membership.

Membership is a connection capability:

- It grants a member access to the container entity's beliefs during context assembly.
- It supports many-to-many links.
- It can be nested.
- It is transitive downward for context access.
- It does not automatically push child knowledge upward to parent entities.

Authored membership links define starting access. Runtime play can add or revoke access through append-only access events without editing the compiled source fabric.

Example:

- Jade is connected to Mafia with membership-like access.
- Inner Circle is connected to Mafia as a nested affiliation.
- If Jade is a member of Inner Circle and Inner Circle is a member of Mafia, Jade can receive Mafia beliefs through the chain.
- Mafia does not automatically receive all Inner Circle beliefs.

Membership loops are invalid. If Entity A is a member of Entity B, Entity B cannot also be a member of Entity A.

## Propositions

A proposition is a claim about the world.

Examples:

- Jade is undercover.
- Luke is a dirty cop.
- Mike loves Jade.
- Mafia believes Jade is useful.
- Jade usually appears calm.
- Luke's phone appears locked.

Canonical truth always exists in the engine. Unknown-to-author mysteries are not unresolved truths; they are canonical truths hidden from the author UI or ordinary author view.

## Beliefs

A belief is a holder-specific stance toward a proposition.

Beliefs may be true, false, conflicted, stale, source-linked, or based on poor evidence. Multiple conflicting beliefs about the same proposition may coexist for the same holder when they come from different sources.

MVP belief strength:

- `+3`: treats as true
- `+1`: suspects or leans true
- `0`: no stance or neutral
- `-1`: doubts or leans false
- `-3`: treats as false

Internal language should prefer "belief strength" over "knowledge" where precision matters. A character can treat something false as true with strength `+3`.

## Belief History And Current Belief

Belief history preserves the journey. Current belief supports fast context assembly.

MVP approach:

- Keep append-only belief history.
- Derive current beliefs as the strongest and latest relevant accessible records.
- Treat current-belief materialization as a future cache only, not as authoritative state.
- Do not require explicit `supersedes` pointers.
- A later belief can supersede earlier beliefs by strength and recency while keeping the earlier journey intact.

Example:

- Mike first doubts Jade is undercover.
- Mike later treats it as true after Jade tells him.
- Both remain in history.
- The current context usually receives the later, stronger belief unless the contradiction is relevant.

## Belief Events

Belief changes should be linked to events when provenance matters.

Possible modes:

- `held`
- `accessed_through_membership`
- `retained_after_access_loss`
- `observed`
- `experienced`
- `inferred`
- `told`
- `briefed`
- `read`
- `stolen`
- `generated`
- `joined`

Events answer how a belief entered a holder's context.

Example:

- Mike believes Jade is undercover because Pete told him.
- Pete believes Mike loves Jade because he observed his behavior.
- Mike believes Luke is dirty because he read messages on Luke's phone.

## Surfaces And First Impressions

Projected surface is what an entity normally makes observable to others.

It is not the same as inner truth.

Both can be true:

- Jade is nervous internally.
- Jade usually appears calm.
- Jade believes she appears nervous.
- Mike observes Jade appearing calm.

Projected surfaces are optional. They are useful when first impressions matter.

Observation channels determine what can be noticed:

- `in_person`
- `text`
- `image`
- `audio`
- `video`
- `@artifact`

First impressions are generated once per observer-entity pair, except artifacts may use looser inspection rules. First and recent impressions should carry relatively high weight during context assembly because they are dramatically useful and psychologically plausible.

MVP first impressions are deterministic and automatic. When an actor first observes another entity in context, Doxvelt persists a `+1` observed belief derived from the first projected surface line for that entity. AI-generated or player-reviewed impressions can come later.

## Artifacts

Artifacts are belief holders in MVP.

They may expose surface beliefs and protected contents.

MVP can model artifact access as propositions rather than a separate access system:

- Jade can unlock Luke's phone.
- Luke's phone appears locked.
- Luke's phone contains messages with Mafia.

Holding an artifact does not imply full access to its contents. Reading, unlocking, stealing, or inspecting the artifact can create belief events.

Artifacts do not have subjective memories. If an artifact contains a diary entry or note, that text carries the subjectivity of its creator.

## Memories

Memories are prose generated by agents after episode closure.

They are not just facts. They compact experience into an agent's own voice, meaning, and emotional interpretation.

Memory types:

- Episode memories: generated at episode closure and searchable later.
- Long-term memories: promoted or revised by the agent when something is important enough to persist more strongly.

Agents write memories in natural language. Those memories can later be compiled into propositions and belief events.

Affiliations may hold beliefs and provenance, but subjective memories are agent-centered for MVP.

## Context Assembly

An actor's turn context may include:

- Individual current beliefs.
- Active affiliation beliefs through memberships.
- Source labels or natural-language provenance.
- Relevant projected-surface and first-impression beliefs.
- Readable or accessible artifact beliefs.
- Current episode context.
- Selected long-term memories.
- Search results from episode memories.
- Contradictory beliefs, left unresolved for the agent to handle.

Source-linked beliefs should carry provenance information. For example: "held by Mafia; accessed through your affiliation path." The source may affect how much the agent trusts, uses, questions, or internalizes the belief.

## Access Loss And Retention

Losing access to a belief source removes current access to that holder's live beliefs. It does not erase what the actor already encountered.

For MVP, retained knowledge should be created only through episode closure, consistent with the rest of belief persistence. If an actor had access to a source-linked belief during the episode and then loses that access, closure may produce a retained belief for the actor with provenance `retained_after_access_loss`.

Runtime access changes are events, not source edits. A source dossier may say an actor starts with membership access, while the runtime can later record that the access was revoked or restored during play.

Retained beliefs automatically weaken the original stance while preserving direction:

- `+3` becomes `+1`
- `+1` remains `+1`
- `0` remains `0`
- `-1` remains `-1`
- `-3` becomes `-1`

This keeps prior knowledge present but marks it as stale, indirect, or less certain than live access.

## Author Visibility

Author ignorance is visibility metadata, not lack of canonical truth.

Generated hidden truths must persist across runtimes. For MVP, they should be stored in runtime state or hidden persisted records, not normal visible dossier files.

Users may still inspect backend files or databases, but the product should avoid spoiling hidden truths through ordinary UI.

## Simulation Assets

A new Doxvelt simulation or game is assembled from several authored assets:

- Model: metadata about an LLM endpoint.
- World: immutable objective laws and norms that govern the simulation.
- Scenario: objective starting situation for one simulation or game.
- Entity: agent, affiliation, or artifact dossier.
- Connection: authored link between entities, possibly with engine-recognized mechanics.
- Format: output schema for each turn.

Worlds and scenarios describe objective canonical truth only. They do not hold subjective ambiguity. Subjective differences emerge from entities, connections, beliefs, memories, and context assembly.

Users create a simulation by selecting a world, scenario, entities, connections, and format. Entities may select the model that powers their turns.

The same structure should support entertainment and educational use cases. A scenario can be a mystery, a strategy-class stakeholder interview, a supply-chain coordination game, a crisis-response room, or a mission reenactment. The common requirement is that different actors can hold partial, subjective, or mistaken views of the same underlying situation.

Multiple connection variants may exist between the same entities. For example, `jade-michael-1` and `jade-michael-2` can encode different starting dynamics and give the same scenario different social momentum.

## Stateless Invokable Entities

Some useful actors are stateless generators rather than belief holders.

Examples:

- Fate.
- Scene heading generator.
- Weather generator.
- Complication generator.

These invokable entities can be called by the player or engine to spice up play. They are a special entity kind with unstructured Markdown dossiers. They do not need evolving beliefs, memories, or memberships. They may still use models and formats. If one later needs persistent subjective state, it can become a normal entity.

## Open Questions

- How much source weighting should be handled by engine rules versus the acting agent.
- Whether artifact access eventually needs first-class mechanics beyond propositions.
- How strict cycle validation should be for nested memberships beyond preventing direct loops.
- How the compiler should reconcile multiple prose spans that imply the same proposition.
