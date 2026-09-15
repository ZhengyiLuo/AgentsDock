[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$ArtifactDirectory,
  [Parameter(Mandatory = $true, Position = 1)][string]$ExpectedVersion,
  [Parameter(Position = 2)][ValidateSet('stable', 'beta')][string]$ExpectedTrack = 'stable',
  [Parameter(Position = 3)][ValidateSet('x64')][string]$ExpectedArchitecture = 'x64',
  [Parameter(Position = 4)][ValidateSet('require-signed', 'allow-unsigned')][string]$SigningPolicy = 'allow-unsigned',
  [Parameter(Position = 5)][string]$ExpectedPublisher = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Artifacts = [System.IO.Path]::GetFullPath($ArtifactDirectory)
$MetadataName = if ($ExpectedTrack -eq 'beta') { 'beta.yml' } else { 'latest.yml' }
$InstallerName = "AgentsDock-$ExpectedVersion-win-$ExpectedArchitecture.exe"
$BlockmapName = "$InstallerName.blockmap"
$Installer = Join-Path $Artifacts $InstallerName
$Blockmap = Join-Path $Artifacts $BlockmapName
$Metadata = Join-Path $Artifacts $MetadataName
$TemporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) "agentsdock-windows-verify-$PID"
$ApplicationRoot = Join-Path $TemporaryRoot 'installed'

function Assert-Condition {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
  )
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE"
  }
}

function Read-TopLevelYamlScalar {
  param([string]$Text, [string]$Name)
  $Line = ($Text -split "`r?`n" | Where-Object { $_ -match ("^" + [regex]::Escape($Name) + ":\s*") } | Select-Object -First 1)
  if (-not $Line) { return $null }
  return ($Line -replace ("^" + [regex]::Escape($Name) + ":\s*"), '').Trim().Trim("'`"")
}

function Get-Sha512Base64 {
  param([string]$Path)
  $Stream = [System.IO.File]::OpenRead($Path)
  try {
    $Hasher = [System.Security.Cryptography.SHA512]::Create()
    try { return [Convert]::ToBase64String($Hasher.ComputeHash($Stream)) }
    finally { $Hasher.Dispose() }
  } finally {
    $Stream.Dispose()
  }
}

function Find-ToolScript {
  param([string]$LeafName, [string]$PathFragment)
  $PnpmRoot = Join-Path $Root 'electron\node_modules\.pnpm'
  $Match = Get-ChildItem -LiteralPath $PnpmRoot -File -Filter $LeafName -Recurse |
    Where-Object { $_.FullName.Replace('\', '/') -like "*$PathFragment*" } |
    Select-Object -First 1
  if (-not $Match) { throw "Install Electron dependencies before verifying Windows artifacts; $LeafName was not found." }
  return $Match.FullName
}

Assert-Condition (Test-Path -LiteralPath $Installer -PathType Leaf) "Missing $InstallerName"
Assert-Condition (Test-Path -LiteralPath $Blockmap -PathType Leaf) "Missing $BlockmapName"
Assert-Condition (Test-Path -LiteralPath $Metadata -PathType Leaf) "Missing $MetadataName"
Assert-Condition ((Get-Item -LiteralPath $Installer).Length -gt 1MB) "$InstallerName is unexpectedly small"
Assert-Condition ((Get-Item -LiteralPath $Blockmap).Length -gt 100) "$BlockmapName is unexpectedly small"

$Installers = @(Get-ChildItem -LiteralPath $Artifacts -File -Filter "AgentsDock-$ExpectedVersion-win-*.exe")
$Blockmaps = @(Get-ChildItem -LiteralPath $Artifacts -File -Filter "AgentsDock-$ExpectedVersion-win-*.exe.blockmap")
Assert-Condition ($Installers.Count -eq 1 -and $Installers[0].Name -eq $InstallerName) 'Expected exactly one correctly named Windows installer'
Assert-Condition ($Blockmaps.Count -eq 1 -and $Blockmaps[0].Name -eq $BlockmapName) 'Expected exactly one correctly named Windows blockmap'

$MetadataText = Get-Content -LiteralPath $Metadata -Raw
$MetadataVersion = Read-TopLevelYamlScalar $MetadataText 'version'
$MetadataPath = Read-TopLevelYamlScalar $MetadataText 'path'
$MetadataSha512 = Read-TopLevelYamlScalar $MetadataText 'sha512'
$FileUrls = @($MetadataText -split "`r?`n" | ForEach-Object {
  if ($_ -match '^\s+- url:\s*(.+?)\s*$') { $Matches[1].Trim().Trim("'`"") }
})
$FileSha512 = @($MetadataText -split "`r?`n" | ForEach-Object {
  if ($_ -match '^\s+sha512:\s*(.+?)\s*$') { $Matches[1].Trim().Trim("'`"") }
})
Assert-Condition ($MetadataVersion -eq $ExpectedVersion) "$MetadataName version does not match $ExpectedVersion"
Assert-Condition ($MetadataPath -eq $InstallerName) "$MetadataName path does not point at $InstallerName"
Assert-Condition ($FileUrls.Count -eq 1 -and $FileUrls[0] -eq $InstallerName) "$MetadataName must contain exactly one files entry for $InstallerName"
Assert-Condition ($FileSha512.Count -eq 1 -and $FileSha512[0] -eq $MetadataSha512) "$MetadataName top-level and files SHA-512 values disagree"
Assert-Condition ((Get-Sha512Base64 $Installer) -eq $MetadataSha512) "$MetadataName SHA-512 does not match $InstallerName"

$Signature = Get-AuthenticodeSignature -LiteralPath $Installer
if ($SigningPolicy -eq 'require-signed') {
  Assert-Condition ($Signature.Status -eq 'Valid') "Windows installer signature is $($Signature.Status); a valid Authenticode signature is required"
} else {
  Assert-Condition ($Signature.Status -in @('Valid', 'NotSigned')) "Windows installer has an invalid Authenticode status: $($Signature.Status)"
}
if ($Signature.Status -eq 'Valid' -and $ExpectedPublisher) {
  Assert-Condition ($Signature.SignerCertificate.Subject -like "*$ExpectedPublisher*") "Windows installer publisher does not contain '$ExpectedPublisher'"
}

New-Item -ItemType Directory -Force -Path $TemporaryRoot | Out-Null
try {
  New-Item -ItemType Directory -Force -Path $ApplicationRoot | Out-Null
  # /D must be the final NSIS argument. Explicitly replay a per-user install so
  # candidate builds validate the installer itself, not only win-unpacked.
  $InstallProcess = Start-Process -FilePath $Installer -ArgumentList @('/S', '/currentuser', "/D=$ApplicationRoot") -Wait -PassThru
  Assert-Condition ($InstallProcess.ExitCode -eq 0) "Silent installer exited with $($InstallProcess.ExitCode)"

  $Executable = Get-ChildItem -LiteralPath $ApplicationRoot -File -Filter 'AgentsDock.exe' -Recurse | Select-Object -First 1
  Assert-Condition ($null -ne $Executable) 'Installed/unpacked application does not contain AgentsDock.exe'
  # NSIS itself may use a 32-bit bootstrap even for an x64 payload. Validate
  # the actual packaged application executable instead of the installer host.
  $Bytes = [System.IO.File]::ReadAllBytes($Executable.FullName)
  Assert-Condition ($Bytes.Length -gt 64 -and $Bytes[0] -eq 0x4D -and $Bytes[1] -eq 0x5A) 'AgentsDock.exe is not a PE executable'
  $PeOffset = [BitConverter]::ToInt32($Bytes, 0x3C)
  Assert-Condition ($PeOffset -gt 0 -and $PeOffset + 6 -lt $Bytes.Length) 'AgentsDock.exe PE header is invalid'
  Assert-Condition ($Bytes[$PeOffset] -eq 0x50 -and $Bytes[$PeOffset + 1] -eq 0x45) 'AgentsDock.exe PE signature is invalid'
  $Machine = [BitConverter]::ToUInt16($Bytes, $PeOffset + 4)
  Assert-Condition ($Machine -eq 0x8664) "AgentsDock.exe machine is 0x$($Machine.ToString('X4')), expected x64 (0x8664)"
  $ApplicationSignature = Get-AuthenticodeSignature -LiteralPath $Executable.FullName
  if ($SigningPolicy -eq 'require-signed') {
    Assert-Condition ($ApplicationSignature.Status -eq 'Valid') "AgentsDock.exe signature is $($ApplicationSignature.Status); a valid Authenticode signature is required"
  } else {
    Assert-Condition ($ApplicationSignature.Status -in @('Valid', 'NotSigned')) "AgentsDock.exe has an invalid Authenticode status: $($ApplicationSignature.Status)"
  }
  if ($ApplicationSignature.Status -eq 'Valid' -and $ExpectedPublisher) {
    Assert-Condition ($ApplicationSignature.SignerCertificate.Subject -like "*$ExpectedPublisher*") "AgentsDock.exe publisher does not contain '$ExpectedPublisher'"
  }
  $Resources = Join-Path $Executable.DirectoryName 'resources'
  $Asar = Join-Path $Resources 'app.asar'
  $UpdateConfig = Join-Path $Resources 'app-update.yml'
  Assert-Condition (Test-Path -LiteralPath $Asar -PathType Leaf) 'Windows package is missing resources/app.asar'
  Assert-Condition (Test-Path -LiteralPath $UpdateConfig -PathType Leaf) 'Windows package is missing resources/app-update.yml'
  Assert-Condition (-not (Test-Path -LiteralPath (Join-Path $Resources 'disable-auto-update'))) 'Windows release package disables automatic updates'

  $UpdateText = Get-Content -LiteralPath $UpdateConfig -Raw
  Assert-Condition ((Read-TopLevelYamlScalar $UpdateText 'provider') -eq 'github') 'Packaged updater provider is not GitHub'
  Assert-Condition ((Read-TopLevelYamlScalar $UpdateText 'owner') -eq 'ZhengyiLuo') 'Packaged updater owner is not ZhengyiLuo'
  Assert-Condition ((Read-TopLevelYamlScalar $UpdateText 'repo') -eq 'AgentsDock') 'Packaged updater repository is not AgentsDock'
  $ExpectedChannel = if ($ExpectedTrack -eq 'beta') { 'beta' } else { 'latest' }
  Assert-Condition ((Read-TopLevelYamlScalar $UpdateText 'channel') -eq $ExpectedChannel) "Packaged updater channel is not $ExpectedChannel"

  $AsarCli = Find-ToolScript 'asar.js' '/node_modules/@electron/asar/bin/asar.js'
  $FusesCli = Find-ToolScript 'bin.js' '/node_modules/@electron/fuses/dist/bin.js'
  $AsarExtract = Join-Path $TemporaryRoot 'asar'
  New-Item -ItemType Directory -Force -Path $AsarExtract | Out-Null
  Invoke-Checked node $AsarCli extract $Asar $AsarExtract
  $PackageJson = Get-Content -LiteralPath (Join-Path $AsarExtract 'package.json') -Raw | ConvertFrom-Json
  Assert-Condition ($PackageJson.name -eq 'agentsdock-electron') 'ASAR package identity is not AgentsDock'
  Assert-Condition ($PackageJson.version -eq $ExpectedVersion) "ASAR package version does not match $ExpectedVersion"
  if ($env:AGENTSDOCK_EXPECTED_BUILD_NUMBER) {
    Assert-Condition ($null -ne $PackageJson.PSObject.Properties['releaseBuildNumber']) 'ASAR package is missing releaseBuildNumber'
    Assert-Condition ([string]$PackageJson.releaseBuildNumber -eq $env:AGENTSDOCK_EXPECTED_BUILD_NUMBER) "ASAR package build does not match $env:AGENTSDOCK_EXPECTED_BUILD_NUMBER"
  }
  $MainEntry = [string]$PackageJson.main
  Assert-Condition ($MainEntry -eq './out/main/index.js') 'ASAR package declares an unsupported Electron main entry'
  $MainEntryPath = Join-Path $AsarExtract $MainEntry
  Assert-Condition (Test-Path -LiteralPath $MainEntryPath -PathType Leaf) "ASAR is missing declared main entry $MainEntry"
  $MainEntryFile = Get-Item -LiteralPath $MainEntryPath
  Assert-Condition ($MainEntryFile.Length -ge 1024) "ASAR declared main entry is truncated: $($MainEntryFile.Length) bytes"
  foreach ($RequiredPath in @('out\preload\index.cjs', 'out\renderer\index.html')) {
    Assert-Condition (Test-Path -LiteralPath (Join-Path $AsarExtract $RequiredPath) -PathType Leaf) "ASAR is missing $RequiredPath"
  }
  $ForbiddenSources = @(Get-ChildItem -LiteralPath $AsarExtract -File -Recurse | Where-Object { $_.Extension -in @('.map', '.ts', '.tsx') })
  Assert-Condition ($ForbiddenSources.Count -eq 0) 'ASAR contains source maps or TypeScript source files'

  $FuseReport = (& node $FusesCli read --app $Executable.FullName | Out-String)
  foreach ($Expectation in @(
    'RunAsNode is Disabled',
    'EnableCookieEncryption is Enabled',
    'EnableNodeOptionsEnvironmentVariable is Disabled',
    'EnableNodeCliInspectArguments is Disabled',
    'EnableEmbeddedAsarIntegrityValidation is Enabled',
    'OnlyLoadAppFromAsar is Enabled'
  )) {
    Assert-Condition ($FuseReport.Contains($Expectation)) "Electron fuse verification failed: expected '$Expectation'"
  }

  $SmokeData = Join-Path $TemporaryRoot 'user-data'
  New-Item -ItemType Directory -Force -Path $SmokeData | Out-Null
  $OldUserData = $env:AGENTSDOCK_USER_DATA
  $OldDisableAnalytics = $env:AGENTSDOCK_DISABLE_ANALYTICS
  $env:AGENTSDOCK_USER_DATA = $SmokeData
  # This launches the real packaged binary with a fresh, disposable profile,
  # so without this it would mint and report a brand-new anonymous install id
  # to production Mixpanel on every CI run.
  $env:AGENTSDOCK_DISABLE_ANALYTICS = '1'
  try {
    $SmokeProcess = Start-Process -FilePath $Executable.FullName -ArgumentList @('--disable-gpu') -PassThru
    Start-Sleep -Seconds 8
    if ($SmokeProcess.HasExited) {
      throw "Packaged Windows app exited during the clean-runner smoke window with $($SmokeProcess.ExitCode)"
    }
    $TaskkillProcess = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\taskkill.exe') -ArgumentList @('/PID', "$($SmokeProcess.Id)", '/T', '/F') -Wait -PassThru
    Assert-Condition ($TaskkillProcess.ExitCode -eq 0) "Could not terminate the packaged app process tree (taskkill exit $($TaskkillProcess.ExitCode))"
    $SmokeProcess.WaitForExit(5000) | Out-Null
    Assert-Condition $SmokeProcess.HasExited 'Packaged Windows app remained alive after process-tree termination'
  } finally {
    $env:AGENTSDOCK_USER_DATA = $OldUserData
    $env:AGENTSDOCK_DISABLE_ANALYTICS = $OldDisableAnalytics
  }

  $Uninstaller = Get-ChildItem -LiteralPath $ApplicationRoot -File -Filter 'Uninstall*.exe' -Recurse | Select-Object -First 1
  Assert-Condition ($null -ne $Uninstaller) 'Installed application does not contain an uninstaller'
  $UninstallProcess = Start-Process -FilePath $Uninstaller.FullName -ArgumentList @('/S', '/currentuser') -Wait -PassThru
  Assert-Condition ($UninstallProcess.ExitCode -eq 0) "Silent uninstaller exited with $($UninstallProcess.ExitCode)"
  $UninstallDeadline = [DateTime]::UtcNow.AddSeconds(20)
  while ((Test-Path -LiteralPath $Executable.FullName -PathType Leaf) -and [DateTime]::UtcNow -lt $UninstallDeadline) {
    Start-Sleep -Milliseconds 500
  }
  Assert-Condition (-not (Test-Path -LiteralPath $Executable.FullName -PathType Leaf)) 'Silent uninstaller left AgentsDock.exe installed'
} finally {
  for ($Attempt = 1; $Attempt -le 5 -and (Test-Path -LiteralPath $TemporaryRoot); $Attempt++) {
    try {
      Remove-Item -LiteralPath $TemporaryRoot -Recurse -Force -ErrorAction Stop
    } catch {
      if ($Attempt -eq 5) {
        Write-Warning "Could not completely remove verification directory $TemporaryRoot after 5 attempts: $($_.Exception.Message)"
      } else {
        Start-Sleep -Milliseconds (250 * $Attempt)
      }
    }
  }
}

$SignatureSummary = if ($Signature.Status -eq 'Valid') {
  $Signature.SignerCertificate.Subject
} elseif ($ExpectedTrack -eq 'stable') {
  'unsigned stable override'
} else {
  'unsigned beta preview'
}
Write-Host "Verified AgentsDock $ExpectedVersion ($ExpectedTrack) Windows ${ExpectedArchitecture}: exact installer/metadata/blockmap, SHA-512, PE architecture, app identity, updater feed, Electron fuses, clean launch, uninstall, and signature policy ($SignatureSummary)."
