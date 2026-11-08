param(
    [Parameter(Mandatory = $true)][string]$ReverieExecutable,
    [string]$Profile = 'desktop'
)
$ErrorActionPreference = 'Stop'
$doxveltPlugin = Join-Path $PSScriptRoot 'dsh-gui-spike'
$doxveltEngine = (Resolve-Path -LiteralPath $ReverieExecutable).Path
if (!(Test-Path -LiteralPath $doxveltEngine -PathType Leaf)) { throw 'Choose the Reverie executable.' }
if ($Profile -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Invalid DSH profile name.' }
$doxveltDshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$doxveltProfileDirectory = Join-Path (Join-Path $doxveltDshHome 'profiles') $Profile
$doxveltManifest = Join-Path $doxveltProfileDirectory 'package.json'
if (!(Test-Path -LiteralPath $doxveltManifest)) {
    throw 'Open DSH Desktop once to initialize it, then fully quit DSH before installing Doxvelt.'
}
& dsh plugin --profile $Profile add ('link:' + $doxveltPlugin.Replace('\', '/'))
if ($LASTEXITCODE -ne 0) { throw 'DSH could not install the bundle. Fully quit DSH and retry; its output above gives the reason.' }
$doxveltSelected = Get-Content -LiteralPath $doxveltManifest -Raw | ConvertFrom-Json
if ($doxveltSelected.dsh.profile.bundles -notcontains '@doxvelt/dsh') { throw 'DSH did not activate the Doxvelt bundle.' }
$doxveltPatch = Join-Path $doxveltProfileDirectory 'cordis.patch.yml'
$doxveltBefore = if (Test-Path -LiteralPath $doxveltPatch) { [IO.File]::ReadAllText($doxveltPatch) } else { '[]' }
$doxveltContent = [regex]::Replace($doxveltBefore, '(?ms)^# BEGIN DOXVELT INSTALLATION\r?\n.*?^# END DOXVELT INSTALLATION\r?\n?', '')
if ($doxveltContent.Trim() -eq '[]') { $doxveltContent = '' }
elseif ($doxveltContent.TrimStart().StartsWith('[')) {
    $doxveltRows = @(ConvertFrom-Json -InputObject $doxveltContent)
    $doxveltContent = ($doxveltRows | ForEach-Object { '- ' + (ConvertTo-Json -InputObject $_ -Depth 100 -Compress) }) -join "`n"
}
$doxveltEngineYaml = ConvertTo-Json -InputObject $doxveltEngine -Compress
$doxveltBlock = "# BEGIN DOXVELT INSTALLATION`n- id: doxvelt`n  config:`n    reverie: $doxveltEngineYaml`n# END DOXVELT INSTALLATION`n"
$doxveltAfter = $doxveltContent.TrimEnd() + "`n" + $doxveltBlock
$doxveltTemporary = $doxveltPatch + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
$doxveltBackup = $doxveltPatch + '.before-doxvelt-' + [Guid]::NewGuid().ToString('N') + '.bak'
[IO.File]::WriteAllText($doxveltTemporary, $doxveltAfter, [Text.UTF8Encoding]::new($false))
if (Test-Path -LiteralPath $doxveltPatch) {
    if ([IO.File]::ReadAllText($doxveltPatch) -ne $doxveltBefore) { throw 'DSH settings changed during installation. Retry without discarding those changes.' }
    [IO.File]::Replace($doxveltTemporary, $doxveltPatch, $doxveltBackup)
} else { [IO.File]::Move($doxveltTemporary, $doxveltPatch) }
Write-Host 'Doxvelt is installed in DSH. Open DSH, choose a workspace, and activate Doxvelt there.'
Write-Host 'Existing source, stories, model connections and credentials were preserved.'
