param(
    [string]$Profile = 'desktop',
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Doxvelt\plugins')
)
$ErrorActionPreference = 'Stop'
if ($env:PROCESSOR_ARCHITEW6432 -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'This package requires Windows x64 PowerShell.' }
if ($Profile -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Invalid DSH profile name.' }

function Get-PayloadHash([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}

function Test-Payload([string]$Directory) {
    $Directory = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
    $prefix = $Directory + '\'
    $expected = @{}
    foreach ($line in [IO.File]::ReadAllLines((Join-Path $Directory 'SHA256SUMS.txt'))) {
        if ($line -notmatch '^([a-f0-9]{64})  (.+)$') { throw 'Invalid package checksum list.' }
        $hash = $Matches[1]
        $relative = $Matches[2]
        $file = [IO.Path]::GetFullPath((Join-Path $Directory $relative))
        if ([IO.Path]::IsPathRooted($relative) -or $relative.Contains('\') -or $relative.Split('/') -contains '..' -or
            !$file.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or $expected.ContainsKey($file)) { throw 'Invalid package file path.' }
        $expected[$file] = $hash
    }
    if ((Get-Item -LiteralPath $Directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Package directories may not be links.' }
    foreach ($entry in Get-ChildItem -LiteralPath $Directory -Recurse -Force) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Package files may not be links.' }
        if ($entry.PSIsContainer -or $entry.FullName -eq (Join-Path $Directory 'SHA256SUMS.txt')) { continue }
        if (!$expected.ContainsKey($entry.FullName) -or (Get-PayloadHash $entry.FullName) -ne $expected[$entry.FullName]) {
            throw ('Package verification failed: ' + $entry.Name)
        }
        $expected.Remove($entry.FullName)
    }
    if ($expected.Count -ne 0) { throw 'Package is incomplete. Extract the complete release ZIP and retry.' }
}

$doxveltSource = [IO.Path]::GetFullPath($PSScriptRoot)
Test-Payload $doxveltSource
$doxveltRelease = Get-Content -LiteralPath (Join-Path $doxveltSource 'release.json') -Raw | ConvertFrom-Json
if ($doxveltRelease.dirty) { throw 'This is an uncommitted development build. Install a clean release package.' }
if ($doxveltRelease.platform -ne 'win32' -or $doxveltRelease.arch -ne 'x64' -or $doxveltRelease.version -notmatch '^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$') { throw 'Unsupported release manifest.' }
$doxveltCli = Get-Command dsh -ErrorAction SilentlyContinue
if (!$doxveltCli) { throw 'Install DSH Desktop and reopen PowerShell so its dsh command is available.' }
$doxveltVersion = (& $doxveltCli --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $doxveltVersion -ne $doxveltRelease.dshVersion) { throw ('This package requires DSH ' + $doxveltRelease.dshVersion + '. Installed: ' + $doxveltVersion) }
$doxveltDshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$doxveltProfileDirectory = Join-Path (Join-Path $doxveltDshHome 'profiles') $Profile
$doxveltManifest = Join-Path $doxveltProfileDirectory 'package.json'
if (!(Test-Path -LiteralPath $doxveltManifest -PathType Leaf)) { throw 'Open DSH Desktop once to initialize it, then fully quit DSH before installation.' }

# Install a versioned, verified copy; the download folder is disposable afterward.
$doxveltManagedRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$doxveltDigest = Get-PayloadHash (Join-Path $doxveltSource 'SHA256SUMS.txt')
$doxveltDestination = Join-Path $doxveltManagedRoot ($doxveltRelease.version + '-windows-x64-' + $doxveltDigest.Substring(0, 12))
New-Item -ItemType Directory -Path $doxveltManagedRoot -Force | Out-Null
if (!(Test-Path -LiteralPath $doxveltDestination)) {
    $doxveltTemporary = Join-Path $doxveltManagedRoot ('.install-' + [Guid]::NewGuid().ToString('N'))
    Copy-Item -LiteralPath $doxveltSource -Destination $doxveltTemporary -Recurse
    Test-Payload $doxveltTemporary
    # Both absolute paths are beneath the explicitly selected installation root.
    foreach ($target in @($doxveltTemporary, $doxveltDestination)) {
        if (![IO.Path]::GetFullPath($target).StartsWith($doxveltManagedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid installation target.' }
    }
    Move-Item -LiteralPath $doxveltTemporary -Destination $doxveltDestination
}
Test-Payload $doxveltDestination
if ((Get-PayloadHash (Join-Path $doxveltDestination 'SHA256SUMS.txt')) -ne $doxveltDigest) { throw 'Existing installation does not match this package.' }
& $doxveltCli plugin --profile $Profile add ('link:' + $doxveltDestination.Replace('\', '/')) --offline --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw 'DSH could not install Doxvelt. Fully quit DSH and retry; see its output above.' }
$doxveltSelected = Get-Content -LiteralPath $doxveltManifest -Raw | ConvertFrom-Json
if ($doxveltSelected.dsh.profile.bundles -notcontains '@doxvelt/dsh') { throw 'DSH did not activate the Doxvelt bundle.' }

# Migrate only the old source installer's own path setting to bundled discovery.
$doxveltPatch = Join-Path $doxveltProfileDirectory 'cordis.patch.yml'
if (Test-Path -LiteralPath $doxveltPatch) {
    $doxveltBefore = [IO.File]::ReadAllText($doxveltPatch)
    $doxveltAfter = [regex]::Replace($doxveltBefore, '(?ms)^# BEGIN DOXVELT INSTALLATION\r?\n.*?^# END DOXVELT INSTALLATION\r?\n?', '')
    if ($doxveltAfter -ne $doxveltBefore) {
        $doxveltPatchTemporary = $doxveltPatch + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
        [IO.File]::WriteAllText($doxveltPatchTemporary, $doxveltAfter, [Text.UTF8Encoding]::new($false))
        if ([IO.File]::ReadAllText($doxveltPatch) -ne $doxveltBefore) { throw 'DSH settings changed during installation. Fully quit DSH and retry.' }
        [IO.File]::Replace($doxveltPatchTemporary, $doxveltPatch, $doxveltPatch + '.before-doxvelt-' + [Guid]::NewGuid().ToString('N') + '.bak')
    }
}
Write-Host ('Installed Doxvelt ' + $doxveltRelease.version + ' with Reverie ' + $doxveltRelease.reverie.tag + '.')
Write-Host 'Reopen DSH, choose a workspace, and activate Doxvelt. You can delete the extracted download.'
