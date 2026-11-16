# Developing Doxvelt

Player installation is documented in [README.md](README.md). This document
covers source development and release engineering. Read [AGENTS.md](AGENTS.md)
and its required design contracts before engineering changes.

## Source setup

Install Node.js 24 or newer, Bun 1.3.13 or compatible, and Rust 1.99.1 or newer
with Cargo and a working native linker. Windows MSVC builds need the Visual C++
build tools; GNU builds need a matching MinGW toolchain. Use short checkout
and temporary paths on Windows to avoid SQLite path-length limits.

```sh
bun install --frozen-lockfile
bun run api:build
```

For the normal desktop application, install **DSH 0.2.2-rc.3** and extract the
complete [Reverie v0.2.0 Windows package](https://github.com/memrok-com/reverie/releases/tag/v0.2.0),
including its notices. Open DSH once, then fully quit it. Link this checkout:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-dsh.ps1 -ReverieExecutable "C:\path\to\reverie-engine.exe"
```

This developer installer builds Rust and links the source plugin. Keep both
locations stable. Rebuild the API and restart DSH after native changes. This
source workflow intentionally differs from the self-contained player package.

For an isolated development profile, use `bun run dev -- --help`. Supply the DSH
CLI entry point with `--dsh`, Reverie with `--reverie`, and optional data storage
with `--data`. `bun run api` starts the native HTTP listener through its host.
See [CLI/API and runtime configuration](docs/LOCAL_REFERENCE.md).

## Checks

Run the full check before release or a build-affecting change:

```sh
bun run check
bun run ui:build
```

During iteration, prefer the relevant Rust tests (`bun run api:test`), focused
Node tests, `bun run typecheck`, and `node scripts/check-native-boundary.mjs`.
The dependency audit rejects runtime imports of the retired TypeScript engine
and Nuxt. `node scripts/verify-inference-startup.ts` verifies native HTTP startup
and requires local loopback access.

The DSH browser harness at `scripts/dsh-gui-spike/workspace-test.mjs` covers
activation, source authoring, play, memory, process restart and four viewport
sizes. Use its `--desktop` mode with the installed DSH host. Its scripted model
proves integration behavior rather than live model quality.

## Desktop release package

The first distribution target is Windows x64. Release versions are shared by
the root and plugin `package.json`. `scripts/desktop-release.json` pins the DSH
host version and the exact independently published Reverie asset, protocol and
SHA-256. Never resolve a moving `latest` dependency while packaging a release.

After committing and validating the release source:

```sh
bun run desktop:package
bun run desktop:verify -- dist/doxvelt-v0.2.0-alpha.1-windows-x64.zip
```

The packager downloads only the pinned Reverie archive, verifies its digest,
builds Doxvelt with `cargo build --release --locked`, bundles the production
host's JavaScript dependencies, and includes both engines and their notices.
For offline builds, supply `--reverie-archive <ZIP>`; the same pinned digest is
still required. GNU release builders must supply their runtime notice file via
`DOXVELT_COMPILER_NOTICES` unless using this checkout's local w64devkit toolchain.
Rust standard-library license files must be installed with the toolchain.

The outputs are a ZIP and `.zip.sha256` under ignored `dist/`. Release metadata
records the exact source commit and dependency pin. `--allow-dirty` is only for
local packaging experiments: the installer and release verifier reject those
builds. Packaging never publishes or changes Git tags.

The verifier extracts the ZIP away from the checkout, checks every payload hash,
installs and reinstalls into an isolated DSH profile, and exercises workspace
activation, manual play, memory formation and recall using the bundled engines.
The complete desktop browser harness must also pass against the extracted
plugin before publication.

Review and merge the release PR before creating the immutable version tag.
Publish the validated ZIP and checksum as assets on that exact GitHub release;
GitHub's source ZIP is not the player package. Rebuild from the tagged clean
commit, reverify, and check the downloaded assets before advertising the pin in
README. Until publication, README must identify the desktop release as pending.
Keep existing release assets and tags intact. Reverie v0.2.0 is already published
with the required binary and notices; a new Reverie release is needed only when
its actual engine changes.

## Repository landmarks

- `api`: authoritative Rust compiler, simulation engine, persistence, commands,
  drafts, history, archives, workspace authoring and Reverie integration.
- `src/local-api`: native process transport and deployment startup.
- `src/application/workspace-collection.ts`: native workspace transport client.
- `src/agent-runtime`: runtime contracts and credential-owned provider callbacks.
- `src/cli`: thin native CLI launcher.
- `scripts/dsh-gui-spike`: maintained DSH workspace UI and host integration.
- `src/client/stage`: framework-independent transport and recovery clients.
- `src/core` and `src/store`: retired TypeScript behavioral/interoperability
  references; do not add product behavior here.
- `design-system`: canonical visual tokens, fonts, brand assets and specimens.
- `examples`: shipped source templates and authoring examples.

The [Rust migration decision](docs/design/DSH_RUST_MIGRATION.md) supersedes the
earlier Nuxt, TypeScript-only API and Pi runtime choices in historical documents.
Preserve immutable branch history, subjective actor access, explicit acceptance,
memory provenance and local/hosted domain parity across implementation changes.