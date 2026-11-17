<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="design-system/assets/2026-05-doxvelt-wordmark-fg-parchment-raw.svg">
    <img src="design-system/assets/2026-05-doxvelt-wordmark-fg-ink-raw.svg" alt="Doxvelt" width="360">
  </picture>
</h1>

Doxvelt is a turn-based roleplaying game for DeepSeek Harness. Choose who acts
and who hears each turn. Characters carry their own memories, and you can
explore alternate story paths.

## Install on Windows

1. Install [DeepSeek Harness Desktop 0.2.2-rc.3 (Windows x64)](https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.2-rc.3-win-x64.exe).
   Open it once, then fully quit it.
2. Download and extract [Doxvelt v0.2.0-alpha.2 (Windows x64 ZIP)](https://github.com/doxvelt/engine/releases/download/v0.2.0-alpha.2/doxvelt-v0.2.0-alpha.2-windows-x64.zip).
3. Run this in PowerShell from the folder containing `install.ps1`.

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
   ```

## Start playing

Reopen DeepSeek Harness, choose a workspace, and select **Activate Doxvelt for
this workspace**. Choose **New episode**. Use **Perform** to write a turn yourself
or **Generate** to play with a model connected in DeepSeek Harness.

[Player guide](docs/WORKSPACES.md) · [Release notes and checksum](https://github.com/doxvelt/engine/releases/tag/v0.2.0-alpha.2) · [Development](CONTRIBUTING.md)
