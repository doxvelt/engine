# Doxvelt product vision

Doxvelt is a local-first, chat-based roleplaying game for one player and a small cast. You can play any character yourself or hand the next turn to a model-powered actor. The story unfolds one turn at a time. Across episodes, characters carry subjective memories of what they experienced, and the player can revisit an earlier choice without losing the original story.

## Play an episode

The maintained host direction is the normal DSH desktop application. A workspace
can activate Doxvelt and owns a reusable collection of worlds, scenarios,
characters and formats, plus its local saved play and memory. Starting an episode
can create missing collection objects inline. Each new story pins its selected
source and keeps independent experiences. DSH owns workspace navigation, chat
logs, editing primitives and provider credentials. See [workspace play](../WORKSPACES.md).

Perform and Generate use the native segmented control and preserve separate
unsent prose. Opening notation uses `@character` and `#audience`, including
`#all`, without requiring `to` or `|`. Scene headings organize stretches of
turns within an episode; they are player-only annotations and supply no actor
knowledge or memory source. Scenarios retain their starting-premise meaning.
Memorize does not close a chat, and play can continue after memorizing.

Stage is one continuous transcript and one composer. A typical episode has two to four characters, including the one the player usually plays. On each turn, the player can **Perform** by writing the contribution for a chosen character, or **Generate** by choosing an actor. An actor pairs a character with a model configuration. Several configurations can play the same character. Stage offers them as distinct actors and records the configuration used for a generated turn. The character keeps the same identity, perceptions, and memories.

The player can limit who receives a performance. A generated performance can also choose its audience within the player's routing constraints. Each turn shows who spoke and who received it. A stage whisper privately directs the selected actor and is recorded separately from the performance. The actor's whisper and knowledge are distinct from what the audience receives.

Actor, character, audience, and stage whisper should be expressible inline where practical. A player can use controls without learning syntax. Ordinary mentions in dialogue stay part of the performance. Perform uses an explicitly selected, visible composer default; turn overrides never change it. A leading `#Mara,Nell` sets this turn's base and `#Mara(text)` restricts only that span. There is no implicit Everyone default. [Scoped audiences](SCOPED_AUDIENCES.md) defines projection, escaping and the explicit opt-in for proposed observer fallbacks. Generate retains named groups and constrained delegated audience choice.

A manual performance appends on submit. A generated performance appends automatically when its text and audience are complete and valid. The player continues from it or opens the turn to change it. Failed or cancelled generation leaves the last committed history available and keeps enough input to try again.

## Revise a turn

| Player action | Result |
| --- | --- |
| **Save correction** | Replaces the selected turn's wording at the same place in the transcript and keeps the subsequent turns. Available for body-only edits. |
| **Save & generate next turn** | Saves the edit and generates a new immediate successor from that point. The original continuation remains selectable. Use this save action when the edit changes the speaking character or audience. Preselect the actor who generated the old next turn when there is one. |
| **Regenerate this turn** | Generates a replacement at the selected turn's original position, using what the selected character knew immediately before it. Start with the original actor and recorded stage whisper when available. The player can change the actor, complete whisper, or audience before generating. The original path remains selectable. |

The editor preselects the old next actor when its configuration is available. If the old turn was player-authored, the editor offers a configured actor for that character when possible. If a recorded configuration has changed, the player chooses which actor to use. If the new next turn fails to generate, the saved edit remains available and the editor can retry that generation.

An edit that looks in place to the player still has a new source revision. Existing performances, performer attribution, and audiences remain traceable to their versions. Changing which character performs a turn changes whose knowledge the model receives. Changing the audience changes who receives the resulting performance.

## Remember across episodes

The episode in play uses its own transcript as immediate context, scoped to what the character perceived. The player chooses **Memorize** at the end of an episode to form inspectable memories for its characters. Reflection uses each character's perceptions and eligible prior memory. A character can retain an emotional impression, lose details, or draw a confidently wrong conclusion. Played dialogue is evidence of what was said. The speaker's claims and the listener's interpretation can differ from what actually happened.

A memory version belongs to the exact episode revision it was formed from. It is eligible for generation in a **different episode later in fictional time on the selected story path**. A prequel played after a sequel stays free of sequel memories. Continuing an episode after memorizing it still uses that episode's transcript for its own events.

Editing or continuing a memorized episode creates a source revision that needs its own explicit **Memorize** action. The old memory version stays with its original revision. Returning to that revision restores its eligible memories without another model call. If a later memory drew on a prior memory version, its eligibility follows that dependency too.

Show drift near **Memorize** in the source episode and in later episodes on that path where the missing memory matters. A later notice identifies the source episode so the player can return to it. The warnings explain what needs attention while play can continue.

## Product and repository boundary

Doxvelt owns the episode, turn and audience rules, the selected story path, and the eligibility of memory. Reverie remains an independent dependency. Its native engine supplies subjective reflection, selective recall, impressions, and fictional chronology through protocol 1. Doxvelt supplies the character's perceived episode source, the model used for reflection, and the eligible story revisions. A configured executable lets Doxvelt reuse the engine while Reverie retains its own release cycle and can serve other hosts. Integration tests target the native build from Reverie commit `518cb3e911e0fb5a056d7862179c2cae5b6d7c05`. [Reverie architecture](https://github.com/memrok-com/reverie/blob/518cb3e911e0fb5a056d7862179c2cae5b6d7c05/docs/architecture.md)

Reuse a maintained GUI for editing, navigation, transcript rendering, accessibility, and settings wherever its extension points fit. Product code should concentrate on play, revision, perception, and memory. The play prototype uses DeepSeek Harness (DSH) Web with its stock composer and transcript. Doxvelt contributes routing, saved turns, revision and memory controls. DSH also supplies model calls for actor turns and Reverie reflection. Doxvelt passes each actor's selected route and subjective context through its runtime port.

**Repository recommendation:** Continue in `doxvelt/engine` and run the GUI spike on a short-lived branch. The existing engine owns the simulation and history, and its tests give the new experience a behavioral baseline. Tag a release once the replacement play path is ready to ship. Revisit a separate repository if a future distribution or upstream-fork requirement calls for independent ownership and releases.

This is a target for Stage. It changes the existing generated-turn review flow, extends historical editing beyond the fixed original actor, and adds the rule that an episode's own derived memories belong in later episodes. The existing simulation and memory contracts provide the implementation baseline. [Stage experience](https://github.com/doxvelt/engine/blob/0c2e963220f9e6ddf57138e75c97421706319691/docs/design/STAGE_EXPERIENCE.md) · [Historical revision](https://github.com/doxvelt/engine/blob/0c2e963220f9e6ddf57138e75c97421706319691/docs/design/HISTORICAL_REVISION.md) · [Reverie product vision](https://github.com/memrok-com/reverie/blob/main/docs/product-vision.md)

## Open questions

| When it matters | Decision |
| --- | --- |
| Before shipping Stage | Try the visible notation, audience defaults, and actor fallback in real play. |
| Before making stories portable | Decide how to package the local memory catalog with a story and whether fictional dates need finer resolution. |
| Before packaging | Decide whether existing Pi stories need import, which model routes the first release must support, and whether a local browser launch is sufficient or a desktop package is needed. |

Use the [Doxvelt ubiquitous language](STAGE_UBIQUITOUS_LANGUAGE.md) for the play terms and the [DeepSeek Harness GUI spike](../spikes/DSH_GUI_SPIKE.md) to test the host.
