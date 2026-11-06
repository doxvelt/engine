# DeepSeek Harness GUI spike

Can an out-of-tree Doxvelt plugin use the stock DeepSeek Harness (DSH) editor and transcript for ordinary play? The decisive check is whether choosing the next actor, setting an audience, and switching between manual and generated turns feels like playing one scene in one conversation. Doxvelt owns the episode history. DSH hosts the interaction.

## Smallest setup

Use a pinned DSH Web build and one isolated profile. Keep a single conversation open for the entire run. Mount a small Host plugin and a browser contribution, with Doxvelt represented by a fixture that accepts turn commands and returns transcript rows with stable IDs. Use three characters from *The Last Crossing* and two scripted actor configurations. Add a short controllable delay and a forced failure to the generator. This tests the UI boundary without provider credentials, model variability, or real stories.

Start with the stock editor, completion menu, and chat view. Add one character completion source, minimal visible routing controls, and a way to submit the resolved turn through the Host plugin. Use the documented input hooks first. Confirm that the actual keyboard and pointer submission paths can dispatch a Doxvelt command and settle the composer properly. The ordinary Send path is coupled to DSH Session prompting, so working completion alone is insufficient evidence. [Input triggers](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-input-trigger/README.md) · [Composer submission and extension points](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-conversation/README.md) · [Web Client slots](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/slots.md)

## Play the fixture

1. **Perform as Corin.** Use keyboard completion to address Nell only. Mention Mara in the prose. Change the audience using the visible control and then through notation, checking that the two stay in sync. Submit and confirm the audience resolves to Nell. The fixture records one manual performance.
2. **Generate as Nell, then as Mara.** Keep the same DSH conversation and profile. Give Nell a private stage whisper and have the scripted actor choose Corin as the recipient. Successful generation appends one performance automatically. Generate Mara's turn under the other configuration. Check that the adapter gets the selected configuration and Mara's input excludes the exchange she did not receive. Only the performances appear as played turns. The player can reopen the whisper from the generated turn.
3. **Edit a previous turn.** Open the turn inline and save a body-only correction. The following turn stays in place and the composer keeps any unsent continuation. A fixture response can stand in for the branch write. This checks whether a custom turn row can supply the action while reusing the host's transcript and scrolling.
4. **Force one failure and reload once.** A failed generation adds no played turn and leaves the draft available to retry. After reload the fixture supplies the same committed transcript without duplicates. Check the composer and edit interaction at a normal window size with both keyboard and pointer.

Use fixture projections for audience and history. Test memory correctness, live inference, and archive compatibility in later integration work.

## Decide from the smallest working surface

| Outcome | Decision |
| --- | --- |
| Stock editor and transcript work with a completion source, turn controls, and small row contributions | Use DSH as the leading GUI candidate. Build the next slice against the real Doxvelt turn API. |
| Doxvelt submission needs a custom composer, and the host still supplies the transcript, navigation, and editor primitives | Try one documented composer replacement and compare the amount of product code it requires. |
| Routine play requires upstream patches, a duplicate authoritative history, or replacement of both the composer and transcript infrastructure | Stop and compare another host against the same fixture. |

Record the exact DSH version, extension points used, any host changes required, and a short capture of the successful play and failure paths. Check whether the plugin can render Doxvelt-owned turns as a projection rather than treating the Harness model session as canonical story history. DSH is in developer preview, so the version and extension surface matter to maintenance. [DSH release status](https://github.com/deepseek-ai/deepseek-harness#developer-preview) · [Conversation extension model](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/conversation.md)

After a pass, the first real integration slice should prove one memory journey. Memorize a private exchange, change its audience, see the drift notice in a sequel, then switch back to the original path and recover its memory. Check that the same memory stays out of its source episode and any prequel. [Doxvelt product vision](../design/PRODUCT_VISION.md)
