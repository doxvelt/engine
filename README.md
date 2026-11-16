# Doxvelt

Doxvelt is a local, single-user app for turn-based chat RPGs and role-play
simulations inside DeepSeek Harness (DSH). Choose who acts and who hears each
turn; play their words yourself or ask a model for a draft. Characters have
subjective knowledge, beliefs and memories. No Doxvelt account is required.

## Install on Windows

The desktop package includes the Doxvelt plugin, native simulation engine and
Reverie memory engine. You need DSH Desktop; you do not need Node.js, Bun, Rust,
a source checkout or a separate Reverie installation.

The next desktop release is **v0.2.0-alpha.1**. It is being prepared and is not
published yet. The older v0.1.0-alpha.1 is a source-run web alpha and does not
contain this desktop package. Once the desktop release is published:

1. Install **DSH Desktop 0.2.2-rc.3**. The
   [official desktop download](https://deepseek.com/harness/) tracks DSH's current
   version; check `dsh --version` before proceeding. This package requires the
   stated host version. Open DSH once, then fully quit it.
2. Download `doxvelt-v0.2.0-alpha.1-windows-x64.zip` and its `.sha256` file from
   [Doxvelt v0.2.0-alpha.1](https://github.com/doxvelt/engine/releases/tag/v0.2.0-alpha.1).
   Check the ZIP with `Get-FileHash -Algorithm SHA256` against that file, then
   extract the complete ZIP.
3. Open PowerShell in the extracted `doxvelt-v0.2.0-alpha.1-windows-x64` folder:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
   ```

4. Reopen DSH, choose a workspace, and select **Activate Doxvelt for this workspace**.

The installer verifies the package contents and copies them into your user-local
application directory before installing the plugin through DSH. You can delete
the extracted download afterward. Installation requires no administrator access.
If PowerShell cannot find `dsh`, reopen the terminal after installing DSH.

The package pins [Reverie v0.2.0](https://github.com/memrok-com/reverie/releases/tag/v0.2.0),
protocol 1. Its license and third-party notices are included. Reverie remains an
independently released dependency; Doxvelt supplies the compatible version.

## Start playing

Choose **New episode** to create or select a world, starting scenario, characters
and format. **Perform** lets you write a character's turn yourself. Manual play
needs no model configuration. **Models** selects from DSH's existing provider
connections for generation and memory reflection; credentials stay in DSH.

**Episode memory** lets you set fictional dates, inspect memories and deliberately
**Memorize** an episode. Memorizing and ending an episode are separate actions.
See [workspace setup, authoring, play and recovery](docs/WORKSPACES.md).

## Updates and saved stories

Fully quit DSH and run the installer from the new release package. It installs a
versioned copy and updates the same plugin registration. Authored content,
stories and memory stay in each workspace's `.doxvelt` directory; model
connections stay in DSH. Back up the complete workspace before upgrading an
alpha. Simulation archives currently exclude the local Reverie memory catalog
and scene headings, so an archive alone is not a full workspace backup.

The package supports Windows x64 and the stated DSH version. Other platforms
currently require a source build. For source setup, checks, developer linking,
CLI/API use and release packaging, see [CONTRIBUTING.md](CONTRIBUTING.md).
