# Doxvelt

Doxvelt is a local, single-user source-run prototype for turn-based chat RPGs and role-play
simulations. Choose who acts and who hears each turn; play their words yourself
or optionally ask a model for a draft. Characters have subjective knowledge,
beliefs and memories. No Doxvelt account is required.

## DSH Desktop

The current development checkout runs as a plugin in the normal DSH desktop
application. Activate it for any workspace, build a reusable collection of
worlds, scenarios, characters and formats, and open episodes as DSH chats.
Doxvelt data stays in that workspace. Manual play needs no model configuration.

Install this checkout's dependencies with `bun install --frozen-lockfile`, obtain
[Reverie 0.2.0](https://github.com/memrok-com/reverie/releases/tag/v0.2.0), and fully
quit DSH after its first launch. Then install the desktop bundle on Windows:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-dsh.ps1 -ReverieExecutable "C:\path\to\reverie-engine.exe"
```

Reopen DSH, choose a workspace, and select **Activate Doxvelt for this workspace**.
**New episode** creates missing collection objects inline. **Models** uses DSH's
existing provider connections. The Perform/Generate control takes one click;
compact audience notation uses `#Mara` and `#all`.

See [workspace setup, authoring, play and recovery](docs/WORKSPACES.md). This is
development behavior after the published web alpha, tested with the installed
DSH 0.2.2-rc.1 desktop host and Reverie 0.2.0 on Windows.

## Earlier Web alpha

The [v0.1.0-alpha.1 prerelease](https://github.com/doxvelt/engine/releases/tag/v0.1.0-alpha.1)
uses the stock DeepSeek Harness composer and transcript. It is a source-run alpha,
tested with DSH `0.2.2-rc.1` and Reverie `0.2.0` over protocol `1`.

1. Download the release's source ZIP, extract it, and open a terminal in the
   folder containing `package.json`. Install Node.js 24 or newer and Bun 1.3.13.
   Install the project dependencies and the pinned DSH CLI.

   ```sh
   bun install --frozen-lockfile
   npm install --prefix .doxvelt/dsh --ignore-scripts --no-audit --no-fund --save-exact @deepseek-ai/dsh@0.2.2-rc.1
   ```

2. Download the Windows x64 ZIP from [Reverie v0.2.0](https://github.com/memrok-com/reverie/releases/tag/v0.2.0)
   and extract its `reverie-v0.2.0-windows-x64` folder into `.doxvelt`.
   On other platforms, build Reverie from that tag and supply its executable path.

3. Save your private model settings as `.doxvelt/models.json`. This minimal
   example uses an OpenAI-compatible endpoint you provide. Replace the URL and
   model ID with your own. Actor generation requires tool-call support.

   ```json
   {
     "defaultActor": {
       "baseUrl": "http://127.0.0.1:1234/v1",
       "modelId": "your-model"
     }
   }
   ```

4. Start Doxvelt in DSH. The following command uses the extracted Windows engine.

   ```sh
   node scripts/dsh-stage.mjs --dsh .doxvelt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --reverie .doxvelt/reverie-v0.2.0-windows-x64/reverie-engine.exe --models .doxvelt/models.json
   ```

   If DSH asks for a workspace, choose **stage**. Use **Open saved episode**
   to open **The last crossing**. Choose **Perform**, a character and an audience,
   then type and send. The selection stays ready for your next turn.
   **Generate** asks the selected actor to play and appends the result immediately.
   **Episode memory** provides dating, deliberate memorization and inspection.

Stop with **Ctrl+C** in the launch terminal. Keep `.doxvelt/stage` to retain your
stories, memory catalog and DSH profile. Model credentials belong in private
configuration or named environment variables. Do not share that directory.
Manual performances make no model call; generation and memorization use your
configured provider.

On Windows, keep project and data paths short. Deeply nested directories can
exceed SQLite's path limit when reopening an external database. Move the data
to a shorter path or choose a shorter `--data` directory if that occurs.

See [model routes, saved episodes and revision controls](docs/spikes/DSH_GUI_SPIKE.md#play-with-your-models)
for separate actor configurations, reflection, authored stories and launch options.
The [alpha release notes](docs/releases/v0.1.0-alpha.1.md) describe compatibility,
memory drift and current limits.

## Legacy workbench

The earlier Nuxt workbench remains available for authoring and reference. Its
separate launch and draft-review flow below do not describe the DSH alpha.

### Quick start

1. [Download the source ZIP](https://github.com/doxvelt/engine/archive/refs/heads/main.zip),
   unzip it, and open a terminal inside the extracted `engine-main` folder
   (`cd engine-main` from its parent). Or clone and enter the repository:

   ```sh
   git clone https://github.com/doxvelt/engine.git
   cd engine
   ```

2. Install [Node.js 24 or newer](https://nodejs.org/en/download) and
   [Bun 1.3.13 or compatible](https://bun.sh/docs/installation). Then, in that folder:

   ```sh
   bun install
   bun start
   ```

3. Open the URL displayed in the terminal (normally `http://127.0.0.1:3000`).
   Choose **Play the example** to open **The last crossing**. Switch from
   **Stage whisper** to **Perform**, choose **Mara** as Actor and **Nell** as Audience,
   type `We should cross before the storm.`, and click **Perform**.
   Your words appear in the conversation under Mara: that turn is saved.

Use `bun start` each time; `bun run dev` remains supported. Both start the local
API and UI in one terminal. First launch creates an ignored private
`.doxvelt/inference.json` with blank AI fields and usable sizing defaults.
Manual play works immediately and makes no provider request. If the filesystem
cannot publish the configuration atomically, startup warns and manual play
remains available; [create the full skeleton privately by hand](docs/LOCAL_REFERENCE.md#ai-drafts)
if you want AI configuration.

### AI drafts

AI generation is optional. Doxvelt does not install or provide a model server;
use an OpenAI-compatible server and model that support **strict JSON-schema output**
(`response_format: json_schema`), arranged separately. There is no prompt-only fallback;
manual play does not need a model server. Open the configuration path printed in the startup terminal, normally
`.doxvelt/inference.json`. Fill its existing `baseUrl` and `modelId` fields with
your OpenAI-compatible endpoint URL and exact model ID. Put an optional `apiKey`
in the file using your editor; keep it private. Leave `contextWindow` and
`maxTokens` at their defaults unless your model requires different limits.
Save, stop with **Ctrl+C**, and run `bun start` again.

To return to manual play, clear both `baseUrl` and `modelId`, then restart
`bun start`. Remove explicit endpoint/model overrides if you used them.
Filling just one field is an error.
Existing `{}` files still work for manual play. Existing files are never replaced.
Startup's **configured (connection unverified)** message does not test the server.
In Stage, choose **Stage whisper**, enter private direction, and click
**Generate draft**. Review the performance and recipients before **Accept**;
**Discard** leaves history unchanged. [Configuration and security details](docs/LOCAL_REFERENCE.md#ai-drafts).

### Saving and continuing

Accepted turns and saved drafts persist locally in `.doxvelt/runtime.sqlite`.
Home's **Continue** returns to your story; **Play the example** resumes the same
example after restart. Stop both processes with **Ctrl+C** in the launch terminal.
Keep the `.doxvelt` folder to retain your stories; configuration edits apply on
restart. Unsent wording is saved only in this browser when local saving succeeds;
clearing browser storage loses it. Watch recovery warnings.

Stage offers **Revise / alternate paths** on accepted turns to edit or regenerate
an earlier turn and revisit saved alternatives. Unsupported cases show a gate or
error. Identity inspection currently shows public identity, not a character's full
beliefs or memories. Studio edits source; it does not rewrite a running story.
There is no automatic next actor or hosted collaboration.

See [Playing Doxvelt](docs/PLAYING.md) for draft/revision details. Export/import,
access changes and memory-job operations are available through the
[CLI/API reference](docs/LOCAL_REFERENCE.md#cli), rather than all being Stage controls.
Engineering setup and architecture are in [CONTRIBUTING.md](CONTRIBUTING.md).
