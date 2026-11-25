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
# On Linux it needs: dotnet 8 SDK, zip, unzip, and fontconfig (libfontconfig1 on
# Debian/Ubuntu), which SkiaSharp loads when the build turns the avatar masters into
# WebP (build/avatars/AvatarBundle). Without it the build stops with
# "libfontconfig.so.1: cannot open shared object file".
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
#   --api-hosts <a,b>  the API hosts this build may talk to (review AG-2). Not given: production
#                   alone (api.rxvision.shop). A staging or pilot build names its hosts here on
#                   purpose; the first one is where a fresh install signs in.
#   --unsigned-updates  a test build without the owner's update-signing key (audit F-01). Such an
#                   agent installs whatever update the server offers, says "Updates are not signed
#                   in this build." beside its version, and must not go to people's machines.
#                   Without this option the script stops when the public key is not in the source.
#   -c <config>     build configuration (default: Release)
set -euo pipefail

CONFIG="Release"
MODE="auto"       # auto | stub | real
SKIP_APP=0
UNSIGNED_UPDATES=0
API_HOSTS="${RXV_API_HOSTS:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stub) MODE="stub"; shift;;
    --real) MODE="real"; shift;;
    --skip-app) SKIP_APP=1; shift;;
    --api-hosts) API_HOSTS="$2"; shift 2;;
    --unsigned-updates) UNSIGNED_UPDATES=1; shift;;
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

# Audit F-01: an agent that goes to people must check update signatures, so it is built with the
# owner's public key in the source. Without the key the script stops before it builds anything,
# unless the build was asked for as a test build (--unsigned-updates).
UPDATE_KEY="$AGENT_ROOT/src/RXVision.Agent.Core/Update/update-public-key.pem"
UNSIGNED_PROP=()
UNSIGNED_SAID=0
say_unsigned() {
  [[ "$UNSIGNED_SAID" -eq 1 ]] && return 0
  UNSIGNED_SAID=1
  printf '\n*** UPDATES ARE NOT SIGNED IN THIS BUILD: a test build, it must not go to people'"'"'s machines ***\n' >&2
}
no_update_key() {
  cat >&2 <<EOF
ERROR: $1
  $UPDATE_KEY
An agent built without it installs any update the server offers. Do one of these:
  1. Create the key once, on the owner's own computer:
       build/signing/make-update-key.sh <a folder outside the repository>
     then copy update-public-key.pem from that folder to
       src/RXVision.Agent.Core/Update/update-public-key.pem
     and commit it (the public half only; build/signing/README.md).
  2. For a test build that never goes to people's machines, run this script again
     with --unsigned-updates.
EOF
  exit 1
}
WILL_BUILD_APP=0
if [[ "$SKIP_APP" -eq 0 && "$MODE" != "stub" && ( "$MODE" == "real" || -f "$APP_PROJECT" ) ]]; then WILL_BUILD_APP=1; fi
if [[ -f "$UPDATE_KEY" ]]; then
  if [[ "$UNSIGNED_UPDATES" -eq 1 ]]; then
    echo "NOTE: --unsigned-updates has no effect: the update key is in the source, so this build checks update signatures." >&2
    UNSIGNED_UPDATES=0
  fi
elif [[ "$WILL_BUILD_APP" -eq 1 ]]; then
  if [[ "$UNSIGNED_UPDATES" -eq 1 ]]; then
    say_unsigned
    UNSIGNED_PROP=("-p:RxvAllowUnsignedUpdates=true")
  else
    no_update_key "the update-signing public key is not in the source:"
  fi
fi

# What is about to be wrapped in the installer says itself whether it checks update signatures
# (the build bakes RxvUpdateSigning into RXVision.Agent.Core.dll). Read it back, so an agent built
# without the key is never packed by accident, a payload reused with --skip-app included.
check_payload_signing() {
  command -v unzip >/dev/null 2>&1 || { echo "ERROR: unzip is required (reads the payload back to check it)" >&2; exit 1; }
  # A stand-in payload has no agent in it: nothing to check.
  unzip -l "$PAYLOAD_ZIP" RXVision.Agent.Core.dll >/dev/null 2>&1 || return 0
  local signed
  # The fact as the compiler stores it: the name, one length byte, the value.
  signed="$(unzip -p "$PAYLOAD_ZIP" RXVision.Agent.Core.dll | LC_ALL=C grep -a -c 'RxvUpdateSigning.signed' || true)"
  if [[ "${signed:-0}" -ge 1 ]]; then return 0; fi
  if [[ "$UNSIGNED_UPDATES" -eq 1 ]]; then say_unsigned; return 0; fi
  if [[ -f "$UPDATE_KEY" ]]; then
    echo "ERROR: the agent in payload/app.zip was built without the update-signing public key (an older build or a test build). Run this script again without --skip-app." >&2
    exit 1
  fi
  no_update_key "the agent in payload/app.zip does not check update signatures, and the update-signing public key is not in the source:"
}

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
  # ${a[@]+...}: an empty array is "unbound" under set -u in macOS's bash 3.2.
  if [[ -n "$API_HOSTS" ]]; then
    printf '\n*** NOT A PRODUCTION BUILD: this agent talks to %s ***\n' "$API_HOSTS" >&2
    # %2C: a comma inside an MSBuild property given on the command line.
    dotnet publish "$APP_PROJECT" -c "$CONFIG" -r "$RID" --self-contained true \
      -p:PublishSingleFile=false "-p:RxvAllowedApiHosts=${API_HOSTS//,/%2C}" ${UNSIGNED_PROP[@]+"${UNSIGNED_PROP[@]}"} -o "$pub" >&2
  else
    dotnet publish "$APP_PROJECT" -c "$CONFIG" -r "$RID" --self-contained true \
      -p:PublishSingleFile=false ${UNSIGNED_PROP[@]+"${UNSIGNED_PROP[@]}"} -o "$pub" >&2
  fi
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
check_payload_signing

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
if [[ "$UNSIGNED_SAID" -eq 1 ]]; then
  echo "  NOT FOR RELEASE: updates are not signed in this build (--unsigned-updates)."
fi
