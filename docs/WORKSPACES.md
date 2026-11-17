# Play in a DSH workspace

Doxvelt is a DSH plugin. Use the normal desktop application to open a folder,
activate Doxvelt for that workspace, build a collection, and play episodes in
ordinary DSH chats. Other workspaces and authoring chats keep their normal
harness behavior. The desktop package targets DSH 0.2.2-rc.3 on Windows.

## Install once

Follow the [player installation instructions](../README.md#install-on-windows).
The complete desktop package includes both native engines; its installer creates
a managed copy and registers the Doxvelt plugin through DSH. Keep your workspace
when updating the plugin. For source builds and developer linking, see
[CONTRIBUTING.md](../CONTRIBUTING.md#source-setup).

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

Perform controls select the visible composer default. Opening notation overrides
only the current turn and does not change that default:

```text
/perform @Corin #Mara The ferry is ready.
/perform @Corin #Nell,Mara Look at the far bank.
/perform @Corin #all We should leave.
/generate @Nell #Mara Answer her quietly.
```

Perform submits the performance. Generate supplies private direction and appends
the resulting valid performance. Each action keeps its own unsent prose when
switching. `#self` selects only the speaker's own perception. In Generate,
`#actor` delegates audience choice and `#actor:Corin,Mara` limits that choice.
Several actor configurations for a character retain their attached selector,
such as `@Nell#careful`. Perform uses comma-separated lists and
`#Mara(text)` for a span audience; closing the scope restores the base. Choose a
default or a leading turn audience for shared prose. No default starts selected.
Proposed `#Mara(primary|fallback)` requires the explicit observer-fallback checkbox.
Escape literal delimiters as described in [scoped audiences](design/SCOPED_AUDIENCES.md).
Ordinary names never widen delivery. Unknown recipients require correction. Earlier unsent
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
knowledge. Span audiences affect only the performance text they scope.

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

## Export and import

Use **Export / import** in an active workspace. **Export workspace** writes a new
archive folder containing `workspace.json` and `source/`. Keep the complete folder
together; it is the combined Doxvelt and Reverie archive format, version 1.

The archive includes the reusable authored collection, pinned content and accepted
history for every story and path, episode dates, player scene headings, memory
publication ordering and dependencies, and exact Reverie memory snapshots. Old
publications remain available when dates or played source have changed. Source
paths are logical references and are rebound on restore. Provider/model choices
are preferences; credentials, DSH chats, unaccepted drafts, navigation recents,
indexes and unreferenced memory files are not exported. Credential files and
common `api_key` source fields are omitted or redacted as in simulation packages.

Choose an **Archive folder** and a new **Restored workspace folder**, then select
**Review import**. Review validates package integrity, history, subjective source
projections and every native memory using isolated in-memory Reverie databases.
It shows story, path and memory-publication counts. **Import workspace** is bound
to that archive checksum and restores all components into staging before one
atomic directory publication. Existing destination folders are never replaced.
Open the resulting folder as a DSH workspace; choose available models in **Models**
if the saved preferences do not exist in this installation. Transfer makes no
model calls and does not reform memories. Legacy Pi ZIP import is not supported.

The trusted native workspace interface exposes `archive.export` with `targetDir`,
`archive.preview-import` with `packageDir` and `targetDir`, and `archive.import`
with those fields plus the reviewed `archiveHash`. Each request includes the
host-owned `memory` service configuration. The DSH modes are `archive-export`,
`archive-preview-import` and `archive-import`; browser fields cannot choose the
executable or original workspace. These operations are distinct from the legacy
single-simulation `/packages` routes, which retain their compatibility format.

Doxvelt calls Reverie's `exportMemory`, `previewImport` and `importMemory` over
protocol 1. It reconstructs character source from archived immutable history,
including historical heads and publication dates, and authorizes only those
`source.read` callbacks. Doxvelt never reads or writes Reverie's SQLite schema.
Use a Reverie build implementing memory archive version 1; an older executable
fails the transfer without publishing a destination.

Cancellation or failure before final publication leaves no restored workspace.
An interrupted process may leave an unreferenced hidden staging directory; keep
the original archive and retry to the intended absent destination. If publication
succeeded but the reply was lost, retrying the same checksum and target returns
`current` using the completed import receipt, including after restart. Export
refuses existing destinations, and a lost export response can be checked by
reviewing that archive. Archives and source each have a 256 MiB bound and a 10,000
source-file bound. Atomic directory publication is supported on Windows and Linux.

## Archive verification

`tests/workspace-archive.test.ts` uses isolated native workspaces and deterministic
reflection fixtures. Set `DOXVELT_REVERIE_EXECUTABLE` to a current engine build to
run the real two-process round trips, restart, failure and safe-retry checks.
The workspace browser runner also exercises export, review and import through
the maintained DSH controls without provider calls during transfer.

Focused checks run with `node --test tests/workspace-collection.test.ts
tests/dsh-notation.test.ts tests/dsh-composer.test.ts`. The browser runner
`scripts/dsh-gui-spike/workspace-test.mjs` exercises activation, inline creation,
episode date, Perform, headings, editing and reload against isolated workspaces.
Its `--desktop` mode uses the installed desktop application's native host and a
disposable desktop profile. The existing launcher runner checks scripted model
routes, audience boundaries, saved-turn revisions and native-memory restart.
Neither runner writes real stories or calls a paid model.
