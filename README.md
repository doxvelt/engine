# Doxvelt

Doxvelt is a local, single-user prototype for turn-based chat RPGs and role-play
simulations. Choose who acts and who hears each turn; play their words yourself
or optionally ask a model for a draft. Characters have subjective knowledge,
beliefs and memories. No Doxvelt account is required.

## Quick start

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
Manual play works immediately and makes no provider request.

## AI drafts

AI generation is optional. Doxvelt does not install or provide a model server;
use an OpenAI-compatible server you arrange separately. Open the configuration path printed in the startup terminal, normally
`.doxvelt/inference.json`. Fill its existing `baseUrl` and `modelId` fields with
your OpenAI-compatible endpoint URL and exact model ID. Put an optional `apiKey`
in the file using your editor; keep it private. Leave `contextWindow` and
`maxTokens` at their defaults unless your model requires different limits.
Save, stop with **Ctrl+C**, and run `bun start` again.

Both endpoint and model blank means manual-only; filling just one is an error.
Existing `{}` files still work for manual play. Existing files are never replaced.
Startup's **configured (connection unverified)** message does not test the server.
In Stage, choose **Stage whisper**, enter private direction, and click
**Generate draft**. Review the performance and recipients before **Accept**;
**Discard** leaves history unchanged. [Configuration and security details](docs/LOCAL_REFERENCE.md#ai-drafts).

## Saving and continuing

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
