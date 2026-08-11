<#
.SYNOPSIS
  Builds the Windows agent installer and uploads it to S3, where the backend
  serves it from (AgentController -> S3AgentBinaryStore when AGENT_S3_KEY is set).

.DESCRIPTION
  The compiled agent must live in S3 — never in the repo or the Docker image.
  Running this is the ONE step that makes `GET /api/v1/agent/download` work; skip
  it and the endpoint returns 404 ("Agent binary is not available on the server").

  Pipeline:
    1. dotnet publish the WinUI agent (self-contained, win-x64).
    2. Zip that publish folder into timechamp-agent-installer/payload/app.zip.
    3. dotnet publish the installer (single-file exe that embeds app.zip).
    4. Upload the exe to S3 under a versioned key AND the stable "latest" key.

  Point the backend at it with:  AGENT_S3_KEY=agent/RXChampAgent.exe

.PARAMETER Version
  Agent version, used for the versioned S3 key. Default 2.0.0.

.PARAMETER Bucket / Region
  Target S3 bucket / region. Default rx-timechamp / ap-south-1.

.PARAMETER SkipAgentBuild
  Reuse the existing payload/app.zip instead of rebuilding the WinUI agent
  (faster when only re-packing/re-uploading).

.PARAMETER NoUpload
  Build everything but don't touch S3 (local verification).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/publish-agent.ps1
#>
[CmdletBinding()]
param(
  [string]$Version = '2.0.0',
  [string]$Bucket  = 'rx-timechamp',
  [string]$Region  = 'ap-south-1',
  [switch]$SkipAgentBuild,
  [switch]$NoUpload
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$winui     = Join-Path $repo 'timechamp-agent-winui\TimeChampAgentWinUI.csproj'
$installer = Join-Path $repo 'timechamp-agent-installer\TimeChampAgentInstaller.csproj'
$payload   = Join-Path $repo 'timechamp-agent-installer\payload\app.zip'
$outExe    = Join-Path $repo 'timechamp-agent-installer\publish\RXChampAgent.exe'

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }

# 1. Publish the self-contained WinUI agent -------------------------------------
if (-not $SkipAgentBuild) {
  Step 'Publishing WinUI agent (self-contained, win-x64)'
  $pub = Join-Path $env:TEMP "rxchamp-agent-pub-$(Get-Random)"
  dotnet publish $winui -c Release -r win-x64 --self-contained true -p:Platform=x64 -o $pub
  if ($LASTEXITCODE -ne 0) { throw 'WinUI publish failed.' }
  if (-not (Test-Path (Join-Path $pub 'TimeChampAgent.exe'))) {
    throw "Publish produced no TimeChampAgent.exe in $pub"
  }

  # 2. Zip the publish folder CONTENTS at the archive root (Program.cs extracts
  #    them straight into the install dir and expects TimeChampAgent.exe at root).
  Step 'Packing payload/app.zip'
  New-Item -ItemType Directory -Force -Path (Split-Path $payload) | Out-Null
  if (Test-Path $payload) { Remove-Item $payload -Force }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $pub, $payload, [System.IO.Compression.CompressionLevel]::Optimal, $false)
  # Best-effort temp cleanup — a lingering AV/file lock must not abort the upload.
  try { Remove-Item $pub -Recurse -Force -ErrorAction Stop } catch { Write-Host "  (temp cleanup skipped: $($_.Exception.Message))" }
} else {
  Step 'Skipping WinUI build; reusing existing payload/app.zip'
  if (-not (Test-Path $payload)) { throw "No existing payload at $payload" }
}

# 3. Build the single-file installer exe ----------------------------------------
Step 'Publishing installer exe'
$instOut = Join-Path $env:TEMP "rxchamp-installer-$(Get-Random)"
dotnet publish $installer -c Release -o $instOut
if ($LASTEXITCODE -ne 0) { throw 'Installer publish failed.' }
$built = Join-Path $instOut 'RXChampAgent.exe'
if (-not (Test-Path $built)) { throw "Installer produced no RXChampAgent.exe in $instOut" }

New-Item -ItemType Directory -Force -Path (Split-Path $outExe) | Out-Null
Copy-Item $built $outExe -Force
# Best-effort temp cleanup — the freshly-built exe can be briefly AV-locked; a
# failure here must not stop the upload below.
try { Remove-Item $instOut -Recurse -Force -ErrorAction Stop } catch { Write-Host "  (temp cleanup skipped: $($_.Exception.Message))" }
$sizeMb = [math]::Round((Get-Item $outExe).Length / 1MB, 1)
Write-Host "Built $outExe ($sizeMb MB)" -ForegroundColor Green

# 4. Upload to S3 ----------------------------------------------------------------
if ($NoUpload) { Step 'NoUpload set - done (nothing uploaded).'; return }

# Let the AWS CLI use ambient credentials (CI secrets / instance role / aws
# configure). For local dev convenience, fall back to AWS_* in .env.
if (-not $env:AWS_ACCESS_KEY_ID -and (Test-Path (Join-Path $repo '.env'))) {
  Get-Content (Join-Path $repo '.env') | ForEach-Object {
    if ($_ -match '^\s*(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_REGION)\s*=\s*(.*)\s*$') {
      Set-Item -Path "Env:$($matches[1])" -Value ($matches[2].Trim('"').Trim("'"))
    }
  }
}

$versionedKey = "agent/$Version/RXChampAgent.exe"
$latestKey    = 'agent/RXChampAgent.exe'
Step "Uploading to s3://$Bucket/$versionedKey and /$latestKey"
aws s3 cp $outExe "s3://$Bucket/$versionedKey" --region $Region --only-show-errors
if ($LASTEXITCODE -ne 0) { throw 'S3 upload (versioned) failed.' }
aws s3 cp $outExe "s3://$Bucket/$latestKey" --region $Region --only-show-errors
if ($LASTEXITCODE -ne 0) { throw 'S3 upload (latest) failed.' }

Write-Host "`nDone. Set AGENT_S3_KEY=$latestKey (or $versionedKey to pin)." -ForegroundColor Green
