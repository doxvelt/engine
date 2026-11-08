# Play in a DSH workspace

Doxvelt is a DSH plugin. Use the normal desktop application to open a folder,
activate Doxvelt for that workspace, build a collection, and play episodes in
ordinary DSH chats. Other workspaces and authoring chats keep their normal
harness behavior. The desktop host is tested with DSH 0.2.2-rc.1 on Windows.

## Install once

Install this source checkout's dependencies with `bun install --frozen-lockfile`.
Extract the complete Windows package from Reverie 0.2.0, including its notices.
Open DSH once, then fully quit it. From this checkout, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-dsh.ps1 -ReverieExecutable "C:\path\to\reverie-engine.exe"
```

The installer uses DSH's plugin manager to link the Doxvelt bundle and configures
the independent native engine. Keep the checkout and engine in stable locations.
It preserves the existing profile and backs up the previous patch file. Running
it again updates the same bundle and its managed configuration block.

## Build a collection and start play

1. Create or open a folder through DSH's workspace controls.
2. Choose **Activate Doxvelt for this workspace**. Activation creates
   `.doxvelt/workspace.json`; it does not seed a story or call a model.
3. Choose **New episode**. Select the world, starting scenario, format and
   characters, and enter the episode's fictional date. Each picker offers a
   creation action when something is missing.
4. **Create episode** starts a new story and opens its first episode in a new
   DSH chat. Choose **Perform** to write a character's next contribution.
5. Use **Episode memory** to inspect memory, set or revise a date, or deliberately
   **Memorize**. Memorization does not end the episode. You can continue playing
   and memorize again. **End and open next episode** is a separate action.

Use **Continue a saved story** to reopen its current episode and selected story
path. Each story pins its starting collection revision. Reusing a character in
another story does not share that character's played experiences or memories.
Starting scenarios remain fixed for a story; a scene heading does not replace
the scenario or its starting conditions.

## Authoring

**Collection** lists the workspace's source files and provides creation and
editing controls. These are normal Markdown files, also editable directly or
through a normal harness authoring chat. Save source edits explicitly. A stale
editor must reopen changed source before overwriting it. Source publication is
atomic, and creating an object never overwrites an existing file.
In activated workspaces, normal prompt assembly supplies Doxvelt's file-format
and subjective-knowledge guidance to the authoring assistant. That guidance is
absent from other workspaces and from character play.

```text
your-workspace/
  worlds/
  scenarios/
  formats/
  entities/<character-id>/IDENTITY.md
  connections/
  .doxvelt/
    workspace.json
    runtime.sqlite
    scene-headings.sqlite
    memory/
```

Character dossiers retain the existing tag-only knowledge rules: `:+3` marks
something the character takes as true and `:+1` a suspicion. Untagged prose is
preserved as authored source; it is not silently promoted to a belief. See the
[dossier format](design/ENTITY_DOSSIER_FORMAT.md) for additional character files,
connections and access rules.

All Doxvelt-owned collection, play and memory data stays in the workspace folder.
DSH owns its chat logs and keeps those in its normal harness storage. Portable
engine archives currently exclude the local scene-heading and Reverie memory
catalogs; copy the complete workspace to retain those local artifacts.

## Models

**Models** selects character-generation and reflection models from providers
already configured in DSH. Credentials remain with DSH. With no character model,
manual Perform works without a dummy endpoint. Reflection defaults to the
character-generation model when no separate reflection model is selected.
Generation requires the provider's tool-call support; reflection must return
the requested structured memory. Scripted integration checks do not establish
live model quality or every provider's compatibility.

## Compact routing

The controls and the opening routing notation describe the same turn:

```text
/perform @Corin #Mara The ferry is ready.
/perform @Corin #Nell #Mara Look at the far bank.
/perform @Corin #all We should leave.
/generate @Nell #Mara Answer her quietly.
```

Perform submits the performance. Generate supplies private direction and appends
the resulting valid performance. Each action keeps its own unsent prose when
switching. `#self` selects only the speaker's own perception. In Generate,
`#actor` delegates audience choice and `#actor:Corin,Mara` limits that choice.
Several actor configurations for a character retain their attached selector,
such as `@Nell#careful`; separate `#` tokens name audiences. Routing occupies
the opening line before the prose. Names and tags in the performance do not
silently widen delivery. Unknown recipients require correction. Earlier unsent
`to … |` drafts remain readable and can be reformatted through the controls.
DSH currently supplies completion for `@` and `/`, while `#` audiences are typed
or chosen through the routing controls. A character whose ID is a shorthand
word uses an escaped recipient such as `#[all]`, preserving private delivery.

## Scene headings

**New scene** adds a heading at the current place in the episode. Headings
organize the player's transcript only. They do not enter model prompts,
perceptions, canonical events or reflection source, and do not change memory
eligibility. Headings persist locally, follow the originating story path and
its descendants, and reopen with the episode. They give no character new
knowledge. Different audiences for parts of one performance remain future work.

## Host operations and recovery

The bundle derives a workspace from the chat's DSH header and registered
workspace directory. Browser commands cannot select arbitrary host directories.
Writes are serialized per workspace. Requests cancelled before their mutation
leave prior saved state intact. Authoring chats continue to use DSH normally;
Doxvelt episode chats claim their play commands and prevent ordinary harness
prompting from becoming a separate model conversation.

The plugin's POST endpoint `/api/doxvelt-fixture` retains its prototype path for
compatibility. Every request carries `sessionId` and `mode`. Workspace modes are
`saved`, `workspace-activate`, `collection`, `collection-create`, `collection-read`,
`collection-save`, `workspace-models`, `workspace-save-models`, and `create-story`.
Play, revision and memory modes retain their existing host operations. New
`scene-status` and `scene-create` commands expose the captured head and an
idempotent scene-heading write. The local API adds an optional
`POST /simulations/:id/scene-headings` operation with `branchId`, `expectedHead`,
`commandId` and `title`, plus `sceneHeadings` in its Stage projection.

Source writes carry an expected source revision. Story setup carries a collection
revision and stable operation ID, and validates the exact source again before
starting. A safe retry reuses that ID. Complete creation returns `status: complete`.
If the story saves but dating fails, `status: partial` includes the saved story
and `pending: date`; open that story and retry dating without creating another.
Workspace errors include stable `code` values such as `inactive-workspace`,
`source-changed`, `collection-changed`, `configuration-changed`, and
`workspace-unregistered`. Failure details from model providers are not exposed
as workspace-operation errors. Reverie's protocol remains version 1.

## Verification

Focused checks run with `node --test tests/workspace-collection.test.ts
tests/dsh-notation.test.ts tests/dsh-composer.test.ts`. The browser runner
`scripts/dsh-gui-spike/workspace-test.mjs` exercises activation, inline creation,
episode date, Perform, headings, editing and reload against isolated workspaces.
Its `--desktop` mode uses the installed desktop application's native host and a
disposable desktop profile. The existing launcher runner checks scripted model
routes, audience boundaries, saved-turn revisions and native-memory restart.
Neither runner writes real stories or calls a paid model.
