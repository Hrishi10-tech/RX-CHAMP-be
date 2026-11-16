#!/usr/bin/env bash
# Builds the RX Vision Windows agent installer, end to end, on Linux or macOS.
#
#   1. Publish the Avalonia app (src/RXVision.Agent) self-contained for win-x64
#      into a temp folder, with RXVision.exe at its root.
#   2. Ensure appsettings.json (production defaults) is in that folder.
#   3. Zip the folder CONTENTS into packaging/windows/RXVision.Installer/payload/app.zip
#      (RXVision.exe must be at the zip root; the installer extracts it straight into app\).
#   4. Publish the installer (single-file, self-contained win-x64) to dist/windows/RXChampAgent.exe.
#   5. Print its size and SHA-256.
#
# The UI app is being written in parallel and may not exist or build yet. Pass
# --stub to build a tiny stand-in app named RXVision instead, so the installer and
# this script can be verified end to end. With no flag the script uses the real app
# project when it is present and falls back to the stub (with a warning) when it is not.
#
# Options:
#   --stub          force the stand-in payload (do not use the real app project)
#   --real          require the real app project (fail if missing or it fails to build)
#   --skip-app      reuse the existing payload/app.zip (only rebuild the installer)
#   -c <config>     build configuration (default: Release)
set -euo pipefail

CONFIG="Release"
MODE="auto"       # auto | stub | real
SKIP_APP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stub) MODE="stub"; shift;;
    --real) MODE="real"; shift;;
    --skip-app) SKIP_APP=1; shift;;
    -c) CONFIG="$2"; shift 2;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_PROJECT="$AGENT_ROOT/src/RXVision.Agent/RXVision.Agent.csproj"
INSTALLER_PROJECT="$AGENT_ROOT/packaging/windows/RXVision.Installer/RXVision.Installer.csproj"
PAYLOAD_DIR="$AGENT_ROOT/packaging/windows/RXVision.Installer/payload"
PAYLOAD_ZIP="$PAYLOAD_DIR/app.zip"
DIST_DIR="$AGENT_ROOT/dist/windows"
OUT_EXE="$DIST_DIR/RXChampAgent.exe"
RID="win-x64"

# Progress goes to stderr so the functions below can return a path on stdout cleanly.
step() { printf '\n==> %s\n' "$1" >&2; }

ensure_appsettings() {
  local dir="$1"
  if [[ ! -f "$dir/appsettings.json" ]]; then
    step "Writing production appsettings.json"
    cat > "$dir/appsettings.json" <<'JSON'
{
  "ApiBaseUrl": "https://api.rxvision.shop/api/v1",
  "HeartbeatSeconds": 60,
  "IdleThresholdSeconds": 300,
  "ActivitySeconds": 60,
  "ScreenshotMinutes": 5,
  "AutoUpdate": true,
  "UpdateCheckMinutes": 15
}
JSON
  fi
}

pack_payload() {
  local pub="$1"
  if [[ ! -f "$pub/RXVision.exe" ]]; then
    echo "ERROR: publish produced no RXVision.exe in $pub" >&2
    exit 1
  fi
  ensure_appsettings "$pub"
  step "Packing payload/app.zip"
  mkdir -p "$PAYLOAD_DIR"
  rm -f "$PAYLOAD_ZIP"
  ( cd "$pub" && zip -qr -X "$PAYLOAD_ZIP" . )
}

build_stub() {
  step "Building stand-in payload (a tiny console app named RXVision)"
  local stub; stub="$(mktemp -d)"
  cat > "$stub/RXVision.csproj" <<'CSPROJ'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <AssemblyName>RXVision</AssemblyName>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
CSPROJ
  cat > "$stub/Program.cs" <<'CS'
// Stand-in agent used only to verify the installer and build scripts end to end.
Console.WriteLine("RX Vision stand-in agent. args: " + string.Join(' ', args));
System.Threading.Thread.Sleep(2000);
CS
  local pub; pub="$(mktemp -d)"
  dotnet publish "$stub/RXVision.csproj" -c "$CONFIG" -r "$RID" --self-contained true \
    -p:PublishSingleFile=false -o "$pub" >&2
  rm -rf "$stub"
  echo "$pub"
}

build_app() {
  step "Publishing the Avalonia agent (self-contained, $RID)"
  local pub; pub="$(mktemp -d)"
  dotnet publish "$APP_PROJECT" -c "$CONFIG" -r "$RID" --self-contained true \
    -p:PublishSingleFile=false -o "$pub" >&2
  echo "$pub"
}

if [[ "$SKIP_APP" -eq 1 ]]; then
  step "Reusing existing payload/app.zip"
  [[ -f "$PAYLOAD_ZIP" ]] || { echo "ERROR: no payload at $PAYLOAD_ZIP" >&2; exit 1; }
else
  PUB=""
  case "$MODE" in
    stub) PUB="$(build_stub)";;
    real)
      [[ -f "$APP_PROJECT" ]] || { echo "ERROR: --real requested but $APP_PROJECT does not exist" >&2; exit 1; }
      PUB="$(build_app)";;
    auto)
      if [[ -f "$APP_PROJECT" ]]; then
        PUB="$(build_app)"
      else
        echo "NOTE: $APP_PROJECT not found; building a stand-in payload. Pass --real once the app exists." >&2
        PUB="$(build_stub)"
      fi;;
  esac
  pack_payload "$PUB"
  rm -rf "$PUB"
fi

step "Publishing the installer ($RID, single-file, self-contained)"
INST_OUT="$(mktemp -d)"
dotnet publish "$INSTALLER_PROJECT" -c "$CONFIG" -r "$RID" --self-contained true -o "$INST_OUT"
BUILT="$INST_OUT/RXChampAgent.exe"
[[ -f "$BUILT" ]] || { echo "ERROR: installer produced no RXChampAgent.exe in $INST_OUT" >&2; exit 1; }

mkdir -p "$DIST_DIR"
cp -f "$BUILT" "$OUT_EXE"
rm -rf "$INST_OUT"

SIZE_BYTES="$(stat -c '%s' "$OUT_EXE" 2>/dev/null || stat -f '%z' "$OUT_EXE")"
SIZE_MB="$(awk "BEGIN { printf \"%.1f\", $SIZE_BYTES/1048576 }")"
SHA256="$(sha256sum "$OUT_EXE" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$OUT_EXE" | cut -d' ' -f1)"

step "Done"
echo "  output : $OUT_EXE"
echo "  size   : ${SIZE_MB} MB (${SIZE_BYTES} bytes)"
echo "  sha256 : $SHA256"
