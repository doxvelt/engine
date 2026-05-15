# System Loop

This document captures Doxvelt's runtime mechanics around the subjective context model.

The engine is a turn-based RPG or role-play simulation in the form of a chat. The transcript grows incrementally, one actor turn at a time.

## Experience Model

The default experience is a turn-based chat RPG, but the same loop should support educational and training simulations.

- Each turn belongs to exactly one actor.
- The transcript grows after every turn.
- There is no multi-agent consolidation step in MVP.
- The player decides who acts next.
- Stateless actors can be invoked as actors when useful.

The one-actor-per-turn rule avoids discrepancies that would require reconciliation between simultaneous agent outputs.

## Actor Types

Actors can be:

- Agent entities.
- Affiliation entities, if the group is being played by a model.
- Stateless entities such as Fate or scene heading generator.
- Player characters.

Player characters are simpler than agent entities:

- The player holds their state.
- They do not write memories.
- They can still have surface and connections.
- They can participate in the simulation fabric.

## Player Role

The player can act as director, player character, or both.

As director, the player can:

- Choose the next actor.
- Invoke a stateless actor.
- Provide a stage whisper to the next actor.
- Resume play after source edits.

As a player character, the player contributes directly to the transcript as their character.

## Stage Whispers

A stage whisper is private, directed context supplied by the player to the next actor for the next turn.

Example:

> Mike, remember you have not told Jade that you are in love with her.

MVP behavior:

- A stage whisper is directed to one actor.
- It is visible only for that actor's next turn.
- It is hidden from other actors.
- It is not automatically remembered in future turns.

Future behavior may support ephemeral versus permanent whispers, but that is out of scope for MVP.

## Transcript Model

The engine maintains:

- One shared transcript.
- Subjective context per actor.
- Private stage whispers for targeted turns.
- Actor audience membership and active/inactive state across transcript spans.

Actors should not automatically know transcript spans where they were absent, inactive, or excluded from the turn audience.

Example:

- Luke leaves the cabin.
- Jade and Mike talk while Luke is absent.
- Luke's later turn context does not include that conversation unless he learns it through another route.

MVP access tracking is explicit:

- Add an actor to make them part of the active audience.
- Remove an actor to end their access.
- Temporarily deactivate an actor to pause their access.
- Keep an actor active if they should observe but not act.

The player controls who receives turns by selecting the next actor. Active observers do not act unless selected.

Private conversations are normal turns with restricted audience metadata.

## Context Assembly

For each turn, the engine assembles context for exactly one actor.

Context includes:

- The actor's subjective beliefs.
- Active affiliation beliefs through membership-like connections.
- Relevant memories.
- Relevant first impressions and projected-surface beliefs.
- Accessible artifact beliefs.
- Shared transcript spans the actor had access to.
- Stage whisper for this turn, if any.
- Scenario and world material.
- Required output format.

The context assembler must filter transcript access by actor audience membership, active/inactive state, restricted audience metadata, and private delivery.

Surface channels are recognized as a modeling concept, but channel-filtered perception is out of scope for MVP.

For MVP, include everything accessible until the context becomes too large. Ranking and retrieval can come later.

## Turns

A turn runs roughly as:

1. Player selects next actor.
2. Player optionally provides a stage whisper.
3. Engine assembles actor-specific context.
4. Actor model generates output in the selected format.
5. Output appends to the shared transcript.
6. Engine defers belief extraction until episode closure.

Future behavior may allow a turn response to recommend the next actor and suggested stage whispers, but this is out of scope for MVP.

Format rules are prompt instructions for model actors. The engine does not enforce or repair malformed player-character messages in MVP.

## Episode Closure

At episode closure, each relevant agent writes memories from subjective material.

The player decides when an episode ends. Closure is a deliberate "wrap this beat" action, not an automatic turn count or scheduler event.

Closing an episode pauses play until memory writing and belief extraction complete. The UI should especially warn the player that this is a blocking operation. It should also clarify that closure commits the current beat into persistent memories and beliefs.

The memory input is:

- The agent's subjective context.
- The shared transcript filtered by access.
- Relevant private context available to that agent.

Agents do not write memories from an omniscient objective transcript unless they had access to it.

Only participating agents write memories. An absent or inactive agent writes no memory for an episode whose subjective transcript is empty. If that agent later learns what happened, that learning belongs to the later episode where the agent is present or otherwise receives access.

Episode closure uses this flow:

1. Filter the transcript and context per participating agent.
2. Ask each participating agent to write episode memories.
3. Ask each participating agent to revise or promote long-term memories.
4. Extract subjective beliefs from the agent-written memories.
5. Append extracted beliefs to belief history.

The engine extracts beliefs from memories rather than directly from the transcript because the goal is subjective, colored, distorted, filtered, or biased belief state.

For MVP:

- Belief extraction is automatic.
- Extracted beliefs are player-visible.
- Extracted beliefs are not editable in a review step.
- Agent-written memories become runtime state without player review.
- Contradictory extracted beliefs are appended to belief history; current-belief selection handles strength and recency.
- Stateless actor outputs do not create beliefs directly. They can influence later memories and extracted beliefs through transcript content.

## Canonical Truth During Play

The player cannot directly edit canonical truth during play.

To change objective source material, the player edits the source files, recompiles or resumes play, and decides whether to continue or start over.

## Runtime Persistence

The engine does not know when an RPG has ended. It only knows whether an episode is currently running.

Therefore an RPG instance preserves the whole runtime state:

- Selected source assets.
- Compiled graph.
- Shared transcript.
- Audience membership history.
- Stage whispers where needed for audit/debugging.
- Episode memories.
- Long-term memories.
- Belief history.
- Current-belief materialization if used.

Any closed episode may have a follow-up episode later.

Closed episodes are immutable in MVP. Follow-up play starts a new episode, even if it continues the same scene or conversation.

## MVP Engine Functions

Likely MVP functions:

- `setup`: scaffold worlds, scenarios, formats, entities, connections, and models.
- `compile`: compile source material into runtime fabric and review report.
- `start_sim`: initialize a simulation from selected assets.
- `assemble_context`: build one actor's turn context.
- `advance_turn`: run or record exactly one actor turn.
- `invoke_stateless`: invoke a stateless actor such as Fate.
- `close_episode`: close an episode and trigger memory generation.
- `write_memories`: ask agents to generate episode and long-term memories.
- `extract_beliefs`: extract candidate propositions, beliefs, and events from transcript or memories.

## Open Questions

- How actor audience membership and active/inactive state are stored in transcript metadata.
- Whether stage whispers can later become permanent memories or beliefs.
- How player-character surfaces and connections are authored.
- Whether turn output should include optional next-actor recommendations after MVP.
- When to introduce retrieval and ranking once accessible context outgrows the model window.
- Whether post-MVP should support reopening a closed episode. MVP does not.
