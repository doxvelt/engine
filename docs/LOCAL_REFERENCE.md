# Local CLI and runtime reference

[Player guide](PLAYING.md) · [Contributing](../CONTRIBUTING.md)

## Workspace Shape

A Doxvelt workspace is a local source folder:

```text
workspaces/demo/
  models/
  worlds/
  scenarios/
  formats/
  entities/
  connections/
```

Entity folders hold files such as `IDENTITY.md`, `SURFACE.md`, `BELIEFS.md`, `MEMORY.md`, and `EXAMPLES.md`. Connections describe relationships, memberships, access, rivalry, ownership, or other links between entities.

Source is intentionally prose-first. Lightweight mentions and tags help the compiler:

```md
@jade is undercover inside @mafia. :canonical :hidden
@pete suspects @mike loves @jade. :+1
@jade usually appears calm. :surface:in_person,video :+3
This connection gives @jade access to @mafia knowledge. :access:member
```

## CLI

Stage is the visual play surface. The CLI also supports automation and inspection; Studio handles source authoring.

Create a demo workspace:

```sh
bun run doxvelt -- init workspaces/demo --template executive-interviews
```

Run a small manual slice:

```sh
bun run doxvelt -- compile workspaces/demo --json
bun run doxvelt -- start workspaces/demo --scenario executive-interviews --branch main --command start-demo --json
bun run doxvelt -- actors --json
bun run doxvelt -- turn ceo --manual "We need to understand what is really going on." --audience ceo,student-team --branch main --expected-head <head-from-start> --command turn-1 --json
bun run doxvelt -- context ceo --branch main --json
bun run doxvelt -- close-episode --label "Opening interviews" --branch main --expected-head <head-from-turn> --command close-1 --json
```

Common inspection commands:

```sh
bun run doxvelt -- transcript --json
bun run doxvelt -- memories --json
bun run doxvelt -- beliefs --json
bun run doxvelt -- beliefs ceo --json
```

The local API additionally exposes memory revision/retraction and explicit
memory-job request, run/retry, list, and transition-history routes. The
synchronous CLI `close-episode` command composes a durable closure request with
an immediate job run.

Export and import a local package:

```sh
bun run doxvelt -- export workspaces/package-export --json
bun run doxvelt -- import workspaces/package-export --world workspaces/imported-demo --db .doxvelt/imported-runtime.sqlite --json
```

## AI Drafts

Ordinary continuation model output is a durable, non-canonical draft until accepted.
Historical regeneration instead safely commits/selects an alternate path after validation. The API supports
`POST /simulations/:id/drafts`, followed by explicit acceptance or discard for continuation drafts.
Saved drafts can be recovered after reload or API restart.

Stage AI generation requires server-enforced JSON-schema output from the configured
endpoint/model. The Pi adapter sends OpenAI-compatible chat completions with
`response_format: { type: "json_schema", json_schema: { name: "audience_proposal_v1",
strict: true, schema: ... } }`. The schema requires exactly `text` (string) and
`audience` (array of strings), with no additional properties. Any endpoint that
honors this contract can be used; there is no host allowlist, capability probe or
formatting switch. Configuration does not verify this prerequisite.

Doxvelt also validates nonempty performance text, available/nonduplicate recipients
and director-corrected audience. Unsupported schema requests (including HTTP400/422)
or invalid output fail without advancing history or saving a performance artifact.
There is no prompt-only fallback or automatic repair call. Explicit Retry repeats
the saved prompt/context and output contract. Existing legacy unrouted text requests
retain their text behavior. Manual Perform remains available without inference.

Ordinary `bun start` (or `bun run dev`) creates the private editable configuration automatically. Manual
Perform works with no configuration and makes no model request.

Edit the existing `.doxvelt/inference.json` in your editor, then restart with `bun start`.
The optional `bun run inference:setup` command exclusively creates the same skeleton
when no file exists; it is never a launch prerequisite.

Ordinary launch exclusively creates an owner-only, ignored `.doxvelt/inference.json`
with these editable fields. Existing files are never overwritten. Publication uses
a complete temporary file and an exclusive hard link. If the filesystem does not
support that publication, only an implicit missing default falls back to manual
play with a warning; explicit setup still fails. Other creation/read errors remain
errors. Ordinary CLI runtime overrides still apply.

If the filesystem supports private file permissions but not hard links, stop
Doxvelt and create `.doxvelt` privately (mode 700 on POSIX), then create
`inference.json` in your editor with the **full** skeleton below and owner-only
permissions (mode 600 on POSIX; private user ACL on Windows).
If the filesystem or mount cannot enforce owner-only permissions (common on POSIX
FAT/exFAT mounts), keep the file on a suitable local filesystem instead and launch
`bun start -- --runtime-config /absolute/path/to/inference.json`. Do not relax the
permission check. Save the complete file before restarting; do not replace an
existing file or symlink:

```json
{
  "baseUrl": "",
  "modelId": "",
  "contextWindow": 16384,
  "maxTokens": 1024,
  "apiKey": ""
}
```

Enter an optional API key in the editor, keeping it out of shell history. An omitted
or empty key selects the existing keyless transport (which sends a fixed placeholder
Bearer key). Model IDs are opaque and sent exactly as entered, including colons and
quantization suffixes. Configuration is validated locally; **configured does not
mean connection-verified**. Restart `bun start` after editing configuration.
To return to manual play, clear both `baseUrl` and `modelId` and restart `bun start`;
remove explicit `--runtime-base-url` and `--runtime-model` overrides if used.

This file is plaintext. On POSIX it must be owned by the current user with no group
or other permissions (`chmod 600 .doxvelt/inference.json`); setup creates the directory
with mode 700 and the file with mode 600. Symlink config files are rejected on POSIX.
On Windows, restrict its ACL to your user using Windows file security settings;
POSIX permission checks do not enforce Windows ACLs. Keep the file out of shared
folders, backups and authored content packages. Git ignore is not encryption.

Direct `bun run api` and `bun run dev` use the same resolver, with no home-directory,
workspace, profile or credential-store discovery:

| Setting | Precedence / behavior |
|---|---|
| Config file | `--runtime-config FILE`, otherwise `.doxvelt/inference.json` relative to the launch directory |
| Endpoint/model/sizing | CLI flag > JSON field > sizing defaults (16384 context, 1024 output) |
| API key | Present `DOXVELT_RUNTIME_API_KEY` environment variable > JSON `apiKey`; an explicitly empty environment value forces keyless mode |
| No file | Missing default file is initialized for manual play, or warns and continues if hard-link publication is unsupported; an explicitly selected missing file is an error |
| Blank/present file | `{}` or both endpoint/model blank means manual-only; partial nonblank profiles, invalid JSON, unknown fields, types, values or unsafe permissions fail startup with values withheld |

The endpoint and model must be configured together. Sizing fields are positive
integers up to 1000000, with output no larger than context. URLs must be HTTP(S)
without embedded credentials, query or fragment. CLI values must be nonempty;
unknown options, missing values and duplicate singleton options are errors. There
is no API-key CLI option. Bun's normal dotenv loading can populate the **API's**
environment; the UI gets an allowlisted environment and an intentionally empty
dotenv file, never the runtime key or configuration file. Ambient Nuxt variables
are intentionally not forwarded by `dev`.

Supported API options (also forwarded by `dev`): `--host`, `--port`, `--db`,
repeatable/comma-separated `--origin`, `--runtime-config`, `--runtime-base-url`,
`--runtime-model`, `--runtime-context-window`, `--runtime-max-tokens`.
`start` and `dev` also accept `--ui-port` (default 3000; API default 8787). It supplies the
matching UI API URL and allowed UI origins. For example:

```sh
bun run dev -- --port 8788 --ui-port 3001 --runtime-max-tokens 512
```

Startup checks that both requested ports can be bound before launching children.
Either child's exit or startup failure stops its sibling. SIGINT and SIGTERM
trigger process-tree cleanup, with a 1.5-second grace period then forced termination
(POSIX process groups; Windows `taskkill /T /F`). Nuxt startup is bounded to 90
seconds, including its first page compilation. Only processes started by this
launcher are targeted.

After a failed request, `GET /runtime` provides a fixed, bounded diagnostic for the
most recent failure in that API process: authentication, unavailable endpoint, or
other provider/configuration failure. Stage shows that diagnostic on failed drafts.
Each new runtime invocation clears the previous diagnostic before dispatch, including
pre-aborted attempts, so recovery and non-provider failures do not retain an older error.
No raw provider body is returned or persisted. After restart, the transient diagnostic
is empty; durable draft failures remain available. Check your configured endpoint,
server availability, key and model locally, then retry. These diagnostics are not
an inference quality or connection-health test.

Configuration, credential paths and credentials never enter authored content,
actor prompts, draft provenance or portable archives. Existing safe provider/model
identity provenance remains portable under its existing policy; IDs that cannot
be represented safely are recorded as unavailable while the exact ID is still used
for inference. The legacy blank scaffold's `models/` metadata is unchanged.

The `start` alias runs exactly the same launcher and accepts the same arguments as `dev`.
