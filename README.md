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

Install Rust 1.99.1 or newer, run `bun install --frozen-lockfile` and
`bun run api:build`, obtain
[Reverie 0.2.0](https://github.com/memrok-com/reverie/releases/tag/v0.2.0), and fully
quit DSH after its first launch. Then install the desktop bundle on Windows:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-dsh.ps1 -ReverieExecutable "C:\path\to\reverie-engine.exe"
```

Reopen DSH, choose a workspace, and select **Activate Doxvelt for this workspace**.
**New episode** creates missing collection objects inline. **Models** uses DSH's
existing provider connections. The Perform/Generate control takes one click;
compact audience notation uses `#Mara` and `#all`. Perform also supports
[span audiences](docs/design/SCOPED_AUDIENCES.md), such as `#Mara(text)`, with an
explicit composer default and proposed observer fallbacks behind an opt-in.

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

## Native API and development

Doxvelt's UI runs in DSH. The legacy Nuxt workbench is removed.
Rust owns the API, simulation engine, persistence, source authoring, drafts,
historical alternatives, archives and Reverie integration. The CLI also delegates
its domain operations to Rust. DSH supplies the UI and credential-owned model calls;
Reverie remains the independent native memory engine. No TypeScript domain callback
or simulation store is loaded by the maintained runtime entry points.

Use Node.js 24 or newer, Bun, and Rust 1.99.1 or newer. Before installing the
DSH plugin, build the native API:

```sh
bun install --frozen-lockfile
bun run api:build
bun run check
bun run ui:build
```

`bun run api` starts the native HTTP listener through the application host.
The default address is `http://127.0.0.1:8787`. To use an independently built
executable, set `DOXVELT_API_EXECUTABLE`. No Node HTTP server is started.

For an isolated DSH web development profile, run `bun run dev -- --help`.
The normal desktop installation remains the workflow above; rebuilding this
checkout's API updates the executable used by its linked plugin after restart.
See [workspace play](docs/WORKSPACES.md), [CLI/API reference](docs/LOCAL_REFERENCE.md),
and [the migration boundaries](docs/design/DSH_RUST_MIGRATION.md).
