# Doxvelt ubiquitous language

These are the terms for Stage play and memory. The existing engine glossary also covers world authoring, affiliations, artifacts, and other simulation concepts. In play, **character** identifies a person in the story, **actor** identifies a character paired with a model configuration, and **performer** identifies who authored a particular turn. [Existing engine glossary](UBIQUITOUS_LANGUAGE.md)

## People and turns

| Term | Meaning |
| --- | --- |
| **Player** | The human who plays and directs the episode. They can perform as any character they choose. |
| **Character** | A person in the fiction with a stable identity, their own perceptions and beliefs, and their own memories. Nell is a character whether the player writes her turn or a model generates it. |
| **Model configuration** | The model and generation settings used to play a character. Credentials belong to the runtime environment. |
| **Actor** | A character paired with a model configuration. Nell with one model configuration and Nell with another are distinct actors playing the same character. |
| **Performer** | The author of a particular performance, either the player or a specific actor. |
| **Performance** | The words, actions, or narration contributed for a character. |
| **Turn** | One committed performance for one character, with its performer and audience recorded. A turn appends to the current episode. |
| **Audience** | The other characters who receive a particular performance. The speaking character has its own perception of its contribution. A character named in the text need not be part of the audience. |
| **Audience limit** | The set of other characters an actor may choose from when the player delegates delivery. A reference to someone in the whisper leaves the limit in force. |
| **Stage whisper** | Private direction for the actor generating a turn. The recorded complete whisper can be reopened and replaced for regeneration. Only the resulting performance is delivered to its audience. |
| **Perception** | A character's experience of a played event or received performance. Hearing a claim gives the character a perception of the claim being made. Its truth is a separate question. |
| **Stage** | The play surface for reading the episode, composing turns, editing history, and inspecting memory. |

## Story and revision

| Term | Meaning |
| --- | --- |
| **Collection** | The reusable authored worlds, scenarios, formats, characters and connections in one DSH workspace. |
| **Story** | An independent playthrough started from selected pinned collection objects, with its own history paths and memories. |
| **Scenario** | A reusable premise and starting situation selected when a story begins. |
| **Scene heading** | A player-only heading organizing a group of turns. It supplies no character knowledge or reflection source. |
| **Episode** | A played scene or stretch of play with a transcript, a place in fictional time, and a deliberate opportunity to memorize it. |
| **Transcript** | The ordered record of played turns for the selected episode revision. Each character receives their own perception of that record as immediate context. |
| **Fictional time** | When the story takes place. It determines which other episodes are prequels or sequels regardless of the order in which the player opens or plays them. |
| **Episode revision** | A particular version of the episode's played source. A body correction can create a new revision while carrying forward all subsequent performances. |
| **Story path** | The selected continuation through versioned history. The engine calls a possible line of history a **branch**. An alternate path preserves a different version or continuation. |
| **Save correction** | Save a body-only edit while carrying forward all subsequent turns. |
| **Save & generate next turn** | Save the selected edit and generate a new immediate successor on an alternate path. Preselect the old next turn's actor when available. |
| **Regenerate this turn** | Generate a new performance for the selected turn using the chosen character's knowledge immediately before it. |

## Memory and context

| Term | Meaning |
| --- | --- |
| **Belief** | What a character takes to be true, suspects, or doubts. It can diverge from what happened. |
| **Reflection** | The process of forming subjective memories from a character's perceptions of an episode and eligible prior memories. |
| **Memorize** | The player's explicit action to run reflection for the selected episode revision. |
| **Memory version** | The inspectable result of memorizing an episode revision, with character-specific content and source references. It follows its source and any prior memory versions it relied on. |
| **Memory drift** | The state where a revised episode or its changed dependencies leave a story path without matching memories. An earlier version can still be eligible on its original path. |
| **Eligible memory** | Memory whose source and dependencies match the selected story path and come from episodes earlier in fictional time than the episode in play. |
| **Recollection** | The part of eligible memory selected and supplied for a character's upcoming generation. |
| **Impression** | A broader subjective sense, such as familiarity or mistrust, formed across one or more experiences. Its eligibility follows its sources. |

See the [Doxvelt product vision](PRODUCT_VISION.md) for the play flow and open decisions.
