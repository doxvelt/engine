# DeepSeek Harness GUI spike

Can an out-of-tree Doxvelt plugin use the stock DeepSeek Harness (DSH) editor and transcript for ordinary play? The decisive check is whether choosing the next actor, setting an audience, and switching between manual and generated turns feels like playing one scene in one conversation. Doxvelt owns the episode history. DSH hosts the interaction.

## Result

**Keep the stock composer and transcript for the next prototype.** The fixture passed in DSH Web `0.2.2-rc.1` at source revision `66491b05`, in Chrome on Windows at 1280 × 850. The out-of-tree plugin added completion and submission sources, three routing controls, and one turn renderer. It used the stock editor, keyboard dispatch, Send button, chat flow, and scrolling.

- Keyboard completion inserted Nell. Changing the audience control rewrote the inline notation, and changing the notation updated the control. Enter committed Corin's performance to Nell only, even though the prose mentioned Mara.
- Send generated Nell's performance and Enter generated Mara's, in the same DSH conversation and profile. The fixture received both selected configurations, and Mara's scripted context excluded the private exchange. The whisper stayed out of played turns and could be reopened from the historical editor.
- A body correction updated the first row at its original position, preserved subsequent turns, and kept the unsent continuation. Cancelling an edit left the played rows alone.
- A scripted failure kept the composer input available. Retry added one turn, and browser reload restored the four committed rows without duplicates.

**Submission limit.** The stock editor lets a plugin claim a leading slash command. The fixture uses `/perform` and `/generate`, and the controls insert that notation on behalf of the player. Plain prose follows DSH's own prompt path. The follow-up below tests supplying the command automatically between turns. [Pinned composer submission logic](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/client/ui-conversation/src/client/input/machine.ts)

**History limit.** The fixture file owns the played state. DSH stores display receipts with stable row IDs and replays them on browser reload. Its sidebar still labels the scene **New Session** because the fixture emits no DSH agent turns. The follow-up below adds a saved episode picker and rebuilds the transcript from Doxvelt after the local API restarts. Stock sign-in and coding controls also remain visible in this Web profile. [Pinned session list logic](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/api/session-controller/src/list.ts)

The initial fixture exercised GUI behavior with scripted generation and history. The follow-up below connects saved episodes to Doxvelt storage.

## Sticky routing and saved episodes

The follow-up kept the stock composer and transcript on DSH Web `0.2.2-rc.1`. After a successful submission, the plugin restores the selected action, character, and audience as a routing prefix. The stock editor accepts typing after that prefix without a click or reselecting a control. The browser run checked consecutive scripted Generate turns and consecutive Perform turns, using both Enter and Send. The prefix stays visible. The stock composer still routes a draft with the prefix removed through ordinary DSH prompting.

**Open saved episode** lists saved Doxvelt simulations and opens the current episode on the saved branch. The test started *The last crossing* through the real Doxvelt local API, wrote one turn to SQLite before launching DSH, then restarted the local API and opened the episode in a fresh DSH profile with an empty transcript. DSH projected the saved row, returned the caret to the composer, and appended two Perform turns to the same Doxvelt branch. The API verified all three turns in order and the same private audience. The picker stays disabled while the composer contains an unsent draft. Doxvelt projects turns through DSH's durable command results. These display records stay outside the model's message history, and Doxvelt keeps the authoritative transcript.

The saved-episode path exercises the current open episode on a saved branch. Generate uses the real Doxvelt draft and acceptance flow with a scripted runtime in the browser test. A model response that contradicts a fixed audience leaves the turn uncommitted and the direction editable. The DSH sidebar keeps its stock **New Session** label. The episode transcript picker and revision actions are described below.

**Audience** defaults to **Everyone** for a new session. You can select one
or several characters, or choose **Only self**. In Generate mode, **Actor
chooses** delegates delivery and **Audience limit** can constrain that
choice. The same settings work in the saved-turn editor.

```text
/perform @Corin to all | The ferry is ready.
/perform @Corin to @Nell, @Mara | Look at this letter.
/generate @Nell to actor among @Corin, @Mara | Answer discreetly.
```

Notation and controls update each other. The browser test checks that Doxvelt
rejects an actor's out-of-bounds audience and keeps the direction in the
composer for retry. It also plays a four-character scene where the two-person
audience excludes a character, then checks that character's model input.

## Reverie episode memory

With the native executable configured, **Episode memory** opens a DSH dialog for dating, memorizing, and inspecting the selected episode. **End and open next episode** preserves the completed transcript and opens a fresh DSH conversation for the next episode on the same Doxvelt story path. It leaves memory formation as a separate player action.

Doxvelt fingerprints the perceived source revision and keeps each publication bound to the fictional date and earlier publications supplied during reflection. The catalog selects matching versions in fictional order on the current path. A memory-powered turn receives its current episode's perceived transcript and eligible earlier recollections. The independent Reverie engine forms and ranks the memories in its native databases. Doxvelt's local memory catalog records the version and its dependencies.

The browser test uses the pinned DSH Web build, the real Doxvelt API and native Reverie executable, and scripted inference. It exercises cancelling an in-progress reflection and verifies that the provider receives cancellation, the episode remains unmemorized, and an explicit retry publishes inspectable memories. It then opens a later episode, generates a turn using those memories, and checks that the earlier raw dialogue is absent from that prompt. The API tests also verify that a prequel, an excluded character, and a sibling path receive only eligible memories, and that returning to a compatible path restores its earlier publication.

**Story path** opens the selected path in a fresh DSH conversation. **Episode transcript** opens a closed episode on that path, including its memory status. Returning to **Original** restores its transcript and matching memory publication. The prototype uses one fictional date per episode slot and keeps the local memory catalog separate from portable simulation archives.

## Revise saved turns

**Save correction** creates a path with the revised wording at the same
position. It keeps the later performances, character, audience, and unsent
composer draft. The correction changes the episode revision, so a previously
memorized episode shows a drift notice until the player memorizes that path.

**Save & generate next turn** opens a new continuation. The editor preselects the old next
actor when its configuration is available. When the old turn was player-authored,
it offers a configured actor for that character if possible. The action can also change the
edited turn's speaker or audience. If generation fails after the edit saves,
the editor offers retry or lets the player open the saved path.

**Regenerate this turn** starts from the original actor, recipients, and
recorded whisper when available. The replacement actor receives only their
eligible knowledge immediately before that turn. The new continuation opens
after the generated turn commits.

The launcher browser test exercises these actions with separate actor models
and verifies the archived branch receipts. It forces a rejected successor and
checks that retry generates it once on the existing edited path.

## Play with your models

Install the Doxvelt dependencies with `bun install --frozen-lockfile`. Install the
pinned DSH build from the command below and build or obtain a native Reverie
executable that supports protocol 1. Save a model configuration outside version
control.

```json
{
  "actors": {
    "nell": {
      "baseUrl": "http://127.0.0.1:1234/v1",
      "modelId": "nell-model"
    },
    "mara": {
      "baseUrl": "https://provider.example/v1",
      "modelId": "mara-model",
      "apiKeyEnv": "MARA_MODEL_KEY"
    }
  },
  "reflection": {
    "baseUrl": "http://127.0.0.1:1234/v1",
    "modelId": "reflection-model"
  }
}
```

Use the actor IDs in the story and the model IDs advertised by your endpoints.
The launcher uses OpenAI-compatible chat completions. Actor endpoints must
support strict JSON-schema output (`response_format: json_schema`). Set any named credential
environment variables before starting. An optional `defaultActor` supplies
generation for characters without a specific route and serves as the default
reflection model when you omit `reflection`. You can perform as any character.

For multiple actors playing the same character, make that character's entry
an array. Each configuration has a short lowercase `id` and an optional
display `label`.

```json
{
  "actors": {
    "nell": [
      { "id": "default", "label": "Quick", "baseUrl": "http://127.0.0.1:1234/v1", "modelId": "nell-quick" },
      { "id": "careful", "label": "Careful", "baseUrl": "http://127.0.0.1:1234/v1", "modelId": "nell-careful" }
    ]
  },
  "reflection": { "baseUrl": "http://127.0.0.1:1234/v1", "modelId": "reflection-model" }
}
```

Select **Nell · Careful** in **Actor**, or type
`/generate @Nell#careful to @Corin | Take your time.` A bare `@Nell`
uses her default configuration or the first named entry when there is no
default. The saved turn records the configuration. The history editor restores
it when available and asks you to choose when its model or endpoint changed.

```text
node scripts/dsh-stage.mjs --dsh "<scratch>/node_modules/@deepseek-ai/dsh/lib/bin.js" --reverie "<Reverie executable>" --models "<model config.json>"
```

If DSH asks for a workspace, choose **stage**. Then choose **Open saved episode** and **The last crossing**. The launcher seeds
the example on first run and keeps story data, memories, and the DSH profile
under `.doxvelt/stage`. Use `--data <directory>` for a separate playthrough.
Use `--database <existing SQLite file>` to open a saved Engine database in
DSH. The picker resumes the last selected story path. Use
`--story <source directory> --scenario <id>` to add an authored scenario
from Markdown. Keep the same `--data` directory to reuse the local memory
catalog and DSH profile. This version opens a fresh DSH profile when launched over an earlier spike data directory, and reads the existing Doxvelt database and memory catalog there. Use `--no-open` to print the local browser link.

The launcher browser test exercised independent Nell, Mara, and reflection
routes against a local OpenAI-compatible endpoint with scripted responses. It
verified the configured model IDs, private prompt boundaries, and native memory
formation. It also restarts the launcher with a fresh DSH profile and reopens a saved path, then restarts with the original data directory and verifies that the existing memory can be inspected without another reflection call. Live model quality and provider-specific behavior remain unverified.

## Reproduce

Use Node 24.9 or newer and an installed Chromium browser. Install the pinned test tools into a scratch directory, then run the fixture from the repository. The runner creates an isolated Doxvelt SQLite database and two fresh DSH homes, prints the checks, and saves screenshots and redacted host logs in the run directory. Set DOXVELT_REVERIE_EXECUTABLE to the independent native executable to include the memory checks.

```text
npm install --prefix <scratch> --ignore-scripts --no-audit --no-fund --save-exact @deepseek-ai/dsh@0.2.2-rc.1 playwright-core@1.65.0
node scripts/dsh-gui-spike/run.mjs <scratch> "<Chromium executable>"
node scripts/dsh-gui-spike/launch-test.mjs <scratch> "<Chromium executable>" "<Reverie executable>"
```

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
