[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Project = Join-Path $Root 'electron'
$Output = if ($env:AGENTSDOCK_WINDOWS_OUTPUT) {
  [System.IO.Path]::GetFullPath($env:AGENTSDOCK_WINDOWS_OUTPUT)
} else {
  Join-Path $Root 'dist\windows'
}
$ExpectedOutputRoot = [System.IO.Path]::GetFullPath((Join-Path $Root 'dist'))
$IconSource = Join-Path $Root 'Sources\ZenithDockIOS\Resources\Assets.xcassets\AppIcon.appiconset\AppIcon-1024.png'
$IconOutput = Join-Path $Project 'build\AgentsDock.png'
$Architecture = if ($env:AGENTSDOCK_WINDOWS_ARCH) { $env:AGENTSDOCK_WINDOWS_ARCH } else { 'x64' }

if ($Architecture -ne 'x64') {
  throw "Unsupported Windows architecture: $Architecture (expected x64)"
}
if (-not ($Output.StartsWith($ExpectedOutputRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase))) {
  throw "Refusing to replace Windows output outside $ExpectedOutputRoot"
}
if (-not (Test-Path -LiteralPath $IconSource -PathType Leaf)) {
  throw "Missing Windows icon source: $IconSource"
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

New-Item -ItemType Directory -Force -Path (Split-Path $IconOutput -Parent) | Out-Null
Copy-Item -LiteralPath $IconSource -Destination $IconOutput -Force

Push-Location $Project
try {
  if (-not (Test-Path -LiteralPath (Join-Path $Project 'node_modules') -PathType Container)) {
    Invoke-Checked pnpm install --frozen-lockfile
  }

  Invoke-Checked pnpm typecheck
  # Guided AgentsServer installation is intentionally unavailable on Windows;
  # its test file executes real POSIX shell fixtures. The complete suite still
  # runs on the macOS/Linux builders, while Windows runs every portable test.
  Invoke-Checked pnpm exec vitest run --exclude src/main/server-setup.test.ts
  Invoke-Checked pnpm build

  # Electron Builder downloads checksum-verified platform tools while packaging.
  # Preserve its cache, but tolerate a bounded transient upstream outage without
  # rerunning typecheck, tests, or the renderer build.
  $BuilderAttempts = 3
  $BuilderRetryDelays = @(15, 45)
  for ($Attempt = 1; $Attempt -le $BuilderAttempts; $Attempt++) {
    if (Test-Path -LiteralPath $Output) {
      Remove-Item -LiteralPath $Output -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $Output | Out-Null

    & pnpm exec electron-builder --win nsis --x64 --publish never "--config.directories.output=$Output"
    $BuilderExitCode = $LASTEXITCODE
    if ($BuilderExitCode -eq 0) {
      break
    }
    if ($Attempt -eq $BuilderAttempts) {
      throw "electron-builder failed after $BuilderAttempts attempts (last exit code $BuilderExitCode)"
    }

    $DelaySeconds = $BuilderRetryDelays[$Attempt - 1]
    Write-Warning "electron-builder attempt $Attempt failed with exit code $BuilderExitCode; retrying in $DelaySeconds seconds"
    Start-Sleep -Seconds $DelaySeconds
  }
} finally {
  Pop-Location
}

$Installer = @(Get-ChildItem -LiteralPath $Output -File -Filter 'AgentsDock-*-win-x64.exe')
$Blockmap = @(Get-ChildItem -LiteralPath $Output -File -Filter 'AgentsDock-*-win-x64.exe.blockmap')
$Metadata = @(Get-ChildItem -LiteralPath $Output -File | Where-Object { $_.Name -in @('latest.yml', 'beta.yml') })
if ($Installer.Count -ne 1 -or $Blockmap.Count -ne 1 -or $Metadata.Count -ne 1) {
  throw 'Windows packaging did not produce exactly one installer, blockmap, and updater metadata file.'
}

Write-Host "Built $($Installer[0].FullName)"
Write-Host "Built $($Blockmap[0].FullName)"
Write-Host "Built $($Metadata[0].FullName)"
