# System Loop

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

This document defines Doxvelt's turn lifecycle on top of the branch and subjective-context model.

## Experience Model

Doxvelt is a turn-based RPG or role-play simulation in the form of a chat.

- Exactly one actor owns each committed turn.
- The player normally chooses who acts next.
- The transcript grows through accepted turns.
- Generated responses begin as drafts, not reality.
- One branch contains one singular canonical history.
- Editing, regenerating, or forking creates another history path.
- There is no simultaneous multi-agent reconciliation step in the architectural MVP.

The hard-turn rule remains intentional. Branching resolves alternative histories; it does not imply concurrent actors.

## Actor Types

Actors can be:

- agent entities;
- affiliation entities played by a model;
- stateless entities such as Fate or a scene-opening generator;
- player characters.

Player characters participate in the same transcript and perception fabric. The player may initially hold their internal state manually, but this does not make their turns exempt from branch and audience semantics.

Stateless actors can generate output and use approved capabilities but do not accumulate actor memories or evolving beliefs unless promoted to a stateful entity.

## Player Role

The player may act as director, player character, or both.

As director, the player may:

- choose or request the next actor;
- invoke a stateless actor;
- provide private direction;
- accept, edit, reject, or regenerate a generated draft;
- fork or navigate history;
- close an episode;
- inspect author-visible provenance and projections.

As a player character, the player contributes accepted turns attributed to that character.

## Turn Lifecycle

### 1. Select Branch And Actor

Every command identifies a simulation, branch, and expected head. The coordinator rejects stale mutations rather than silently appending to the wrong history.

### 2. Open Draft Transaction

The coordinator opens an isolated transaction for:

- generated text;
- private direction;
- tool and capability results;
- random outcomes;
- proposed world changes;
- proposed memory changes;
- runtime metadata.

Nothing in the draft is canonical yet.

### 3. Assemble Subjective Context

The engine projects context for the selected actor at the expected branch head.

Context includes only branch-valid material:

- actor constitution and current agenda;
- accessible world and scenario material;
- current beliefs and relevant conflicts;
- belief provenance and access paths;
- relevant memories;
- projected surfaces from actual perceptions;
- accessible transcript spans;
- audience and private direction;
- approved skills and capabilities;
- required output format.

Context assembly is a pure query. If an actor newly observes another entity, the observation and resulting first-impression proposal belong to the accepted turn transaction—not the context read.

### 4. Run Manual Or Model Draft

Manual mode records user-supplied actor text in the draft.

Model mode invokes the configured runtime profile. The runtime may call scoped capabilities through the Capability Broker. Capability mutations remain staged inside the draft.

A runtime may suggest another actor or future action, but it cannot choose or commit the next turn unilaterally unless the simulation rules explicitly grant that capability.

### 5. Review Or Regenerate

The player may:

- edit the draft;
- regenerate from the same captured input and context;
- edit the complete stage whisper and generate afresh at the same pre-turn context,
  excluding earlier whispers and unaccepted performances from model input;
- change the runtime profile or model;
- reject the draft;
- accept it.

Regenerating an unaccepted draft does not create canonical branches unless diagnostic draft preservation is enabled.

### 6. Validate And Commit

On acceptance, Doxvelt validates:

- branch head has not changed;
- actor and audience are valid;
- required output shape;
- capability grants and staged events;
- world invariants;
- idempotency identity;
- provenance completeness.

It then atomically commits:

```text
accepted message version
+ staged world events
+ audience and access effects
+ actor perceptions
+ private-direction consumption
+ runtime provenance
= one new branch head
```

Memory work may be included or scheduled from that committed causal node.

## Transcript And Perception

There is one committed transcript per branch path. Actors receive different transcript projections.

A turn records its audience. An actor does not automatically gain access to turns where they were absent, inactive, or excluded.

Example:

- Luke leaves the cabin.
- Jade and Mike speak on a restricted audience.
- Luke's later context excludes those turns.
- If Pete later tells Luke what happened, Luke may perceive and remember Pete's claim—not the original conversation.

Private conversations are ordinary committed turns with restricted audience metadata.

## Audience And Access

Audience and access are runtime events.

Audience events determine who can perceive a turn through presence:

- add;
- remove;
- deactivate;
- reactivate.

Access events determine live access through affiliations, artifacts, or other engine-recognized paths:

- grant;
- revoke.

Authored connections define starting access. Runtime events modify branch-local effective access without rewriting source content.

Access loss removes live access to a source. It does not erase branch-valid perceptions or memories already formed. Later memory consolidation may retain, weaken, distort, or retract the actor's stance.

## Stage Whispers And Private Direction

A stage whisper is private player-supplied context for one target actor's draft.

Default behavior:

- directed to one actor;
- hidden from other actors;
- available only inside its draft transaction;
- consumed only when that draft is accepted;
- not automatically treated as canonical truth;
- not automatically remembered;
- recorded with enough provenance to explain the accepted output.

Rejecting or regenerating a draft does not consume its whisper. Editing accepted history creates a new branch; whisper consumption follows the accepted branch ancestry.

Future direction types may distinguish instruction, recalled fact, emotional cue, or canonical revelation. The architectural MVP keeps one private-direction mechanism.

## Edit, Regenerate, And Fork

### Edit Accepted Message

Select the parent before the message, create a new message version, and continue on a sibling branch. Downstream events and memories from the old path remain on the old branch.

### Regenerate Accepted Response

Create a new draft from the same causal input. Acceptance creates a sibling branch. Tool outcomes and world effects are recomputed inside the new draft.

### Fork

Create a branch reference at any permitted commit and continue from its inherited state.

See [Branching and Memory](BRANCHING_AND_MEMORY.md).

## Episode Closure

The player decides when an episode or meaningful beat closes.

Closure is a branch-bound checkpoint and memory-consolidation request. It may initially block the local UI; the target contract also supports durable jobs.

For each participating actor:

1. Resolve branch-valid subjective perceptions and accessible turns.
2. Generate or deterministically construct an episode-memory proposal.
3. Propose long-term memory assertions, revisions, consolidations, or retractions.
4. Extract subjective beliefs from the actor's memory and interpretation.
5. Validate and attach operations to the closure commit.
6. Update derived memory and belief projections.

Agents absent from the episode receive no memory from its unperceived events.

A closed episode commit is immutable. Editing earlier history creates a branch that does not inherit that closure. The old closed path remains intact.

Closure failures are visible and retryable. A failed memory writer must not leave a half-closed branch with unexplained partial state.

## Canonical Truth During Play

Canonical truth changes only through accepted domain events.

The player may alter history by:

- accepting a new canonical event;
- editing or regenerating into another branch;
- forking from an earlier point;
- changing authored content for a new content version or simulation.

Editing source content does not silently mutate an existing simulation. The player explicitly decides whether to start a new simulation, create a branch from a compatible revision, or keep the pinned content version.

## Runtime Persistence

A simulation preserves:

- pinned content versions;
- branches and heads;
- committed messages and world events;
- audience and access events;
- actor perceptions;
- stage-whisper provenance;
- episode closures;
- memory and belief operations;
- runtime artifacts and model/skill/tool provenance;
- branch checkpoints and derived indexes.

Doxvelt does not need to know when a whole RPG is permanently finished. Any branch may receive a later continuation unless product policy archives or seals it.

## Failure Semantics

- Generation failure creates no committed turn.
- Aborting discards the draft transaction.
- Capability retries are idempotent inside the draft.
- A stale expected head produces a conflict, not an implicit merge.
- Worker failure leaves a resumable or discardable draft/job, not partial canonical state.
- Late memory results attach only to their originating commit and branch.
- Auth and provider failures remain runtime errors, not fictional events.

## Open Questions

- Which turn and event types need explicit rule-engine schemas in the first slice?
- When should player review of memory proposals be offered?
- How are authored source revisions adopted by an existing simulation, if at all?
- Which observation channels require first-class perception mechanics after MVP?
- How should runtime-proposed next actors interact with player control?
- What branch retention, export, and garbage-collection policies are useful locally and when hosted?
- When does retrieval move from full accessible context to ranked actor-specific recall?
