#!/usr/bin/env bash
#
# Uploads the macOS agent zips to S3, where the backend serves them from
# (AgentController -> S3AgentBinaryStore when AGENT_MAC_S3_KEY / AGENT_MAC_X64_S3_KEY
# are set). This mirrors scripts/publish-agent.ps1 for Windows.
#
# Uploading IS the release: each object is stamped with agent-version and
# agent-sha256 metadata, which the backend reads back through GET /agent/version
# and the agent verifies before installing. There is no backend env to change and
# no redeploy afterwards.
#
# For each architecture it writes a versioned key and the stable "latest" key:
#   agent/<version>/RXVision-mac.zip        and  agent/RXVision-mac.zip         (arm64)
#   agent/<version>/RXVision-mac-intel.zip  and  agent/RXVision-mac-intel.zip   (x64)
# Point the backend at the latest keys:
#   AGENT_MAC_S3_KEY=agent/RXVision-mac.zip
#   AGENT_MAC_X64_S3_KEY=agent/RXVision-mac-intel.zip
#
# Usage:
#   build/publish-mac.sh [--version X] [--bucket B] [--region R] [--skip-build] [--no-upload]
#
# Audit F-01: only an agent that checks update signatures is published. The script stops before
# it builds when the owner's public key is not in the source, it does not take
# --unsigned-updates, and it reads each zip back and refuses one whose agent was built without
# the key (a test build left in dist/mac, with --skip-build).
set -euo pipefail

BUCKET="rx-timechamp"
REGION="ap-south-1"
VERSION=""
SKIP_BUILD=0
NO_UPLOAD=0

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --bucket)  BUCKET="$2";  shift 2 ;;
    --region)  REGION="$2";  shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --no-upload)  NO_UPLOAD=1;  shift ;;
    --unsigned-updates) echo "ERROR: --unsigned-updates is refused here: an unsigned build is never published. For a test build use build/build-mac.sh --unsigned-updates." >&2; exit 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST="$AGENT_DIR/dist/mac"

if [ -z "$VERSION" ]; then
  VERSION="$(grep -oE '<Version>[^<]+' "$AGENT_DIR/Directory.Build.props" | head -1 | sed -E 's/.*<Version>//')"
  echo "Version $VERSION (from Directory.Build.props)"
fi
[ -n "$VERSION" ] || { echo "ERROR: no version" >&2; exit 1; }

# Audit F-01: without the owner's public key the agent would install any update the server
# offers, so nothing is built or uploaded from here.
PUBLIC_KEY="$AGENT_DIR/src/RXVision.Agent.Core/Update/update-public-key.pem"
if [ ! -f "$PUBLIC_KEY" ]; then
  cat >&2 <<EOF
ERROR: the update-signing public key is not in the source, and an unsigned build is never published:
  $PUBLIC_KEY
Create the key once, on the owner's own computer:
  build/signing/make-update-key.sh <a folder outside the repository>
then copy update-public-key.pem from that folder to
  src/RXVision.Agent.Core/Update/update-public-key.pem
and commit it (the public half only; build/signing/README.md). Publish again with
RXV_UPDATE_SIGNING_KEY set to the private half.
EOF
  exit 1
fi

if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "==> Building the mac zips first"
  "$SCRIPT_DIR/build-mac.sh"
else
  echo "==> Skipping build; reusing existing zips in $DIST"
fi

ARM_ZIP="$DIST/RXVision-mac.zip"
X64_ZIP="$DIST/RXVision-mac-intel.zip"
[ -f "$ARM_ZIP" ] || { echo "ERROR: missing $ARM_ZIP (run without --skip-build)" >&2; exit 1; }
[ -f "$X64_ZIP" ] || { echo "ERROR: missing $X64_ZIP (run without --skip-build)" >&2; exit 1; }

# The agent installs an update only when the bundle's CFBundleShortVersionString
# equals the advertised agent-version, so a mismatch (--version, or --skip-build
# with older zips) would make every Mac download it, refuse it and back off.
bundle_version() {
  unzip -p "$1" "RX Vision.app/Contents/Info.plist" | python3 -I -c \
    'import plistlib, sys; print(plistlib.loads(sys.stdin.buffer.read()).get("CFBundleShortVersionString", ""))'
}
for zip in "$ARM_ZIP" "$X64_ZIP"; do
  inside="$(bundle_version "$zip" || true)"
  if [ "$inside" != "${VERSION#v}" ]; then
    echo "ERROR: $(basename "$zip") contains version '${inside}', not $VERSION; rebuild (without --skip-build) or fix --version" >&2
    exit 1
  fi
done

# Audit F-01: the agent in each zip says itself whether it checks update signatures (the build
# bakes RxvUpdateSigning into RXVision.Agent.Core.dll: the name, one length byte, the value). A
# zip built without the key, before it was added or with --unsigned-updates, is never uploaded.
for zip in "$ARM_ZIP" "$X64_ZIP"; do
  signed="$(unzip -p "$zip" "RX Vision.app/Contents/MacOS/RXVision.Agent.Core.dll" | LC_ALL=C grep -a -c 'RxvUpdateSigning.signed' || true)"
  if [ "${signed:-0}" -lt 1 ]; then
    echo "ERROR: the agent in $(basename "$zip") was built without the update-signing public key; an unsigned build is never published. Rebuild (without --skip-build)." >&2
    exit 1
  fi
done

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  else sha256sum "$1" | awk '{print $1}'; fi
}

# Security review S-01: sign both zips with the owner's offline key before the SHA-256 is taken.
if [ -n "${RXV_UPDATE_SIGNING_KEY:-}" ]; then
  for zip in "$ARM_ZIP" "$X64_ZIP"; do
    bash "$AGENT_DIR/build/signing/sign-update.sh" "$zip" mac "$VERSION" "$RXV_UPDATE_SIGNING_KEY"
  done
elif [ -f "$PUBLIC_KEY" ]; then
  echo "ERROR: this build checks update signatures; set RXV_UPDATE_SIGNING_KEY to the signing key (build/signing/README.md)." >&2
  exit 1
fi

ARM_SHA="$(sha256 "$ARM_ZIP")"
X64_SHA="$(sha256 "$X64_ZIP")"
echo "  arm64 sha256 $ARM_SHA"
echo "  x64   sha256 $X64_SHA"

if [ "$NO_UPLOAD" -eq 1 ]; then
  echo "==> --no-upload set; nothing uploaded."
  exit 0
fi

# Let the AWS CLI use ambient credentials (CI secrets / instance role / aws
# configure), falling back to AWS_* in backend/.env for local convenience.
if [ -z "${AWS_ACCESS_KEY_ID:-}" ] && [ -f "$AGENT_DIR/../backend/.env" ]; then
  # shellcheck disable=SC2046
  export $(grep -E '^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_REGION)=' "$AGENT_DIR/../backend/.env" | sed 's/[" ]//g' | xargs -I{} echo {}) 2>/dev/null || true
fi

upload() {
  local file="$1" key="$2" sha="$3"
  echo "  s3://$BUCKET/$key"
  aws s3 cp "$file" "s3://$BUCKET/$key" \
    --region "$REGION" \
    --metadata "agent-version=$VERSION,agent-sha256=$sha" \
    --only-show-errors
}

echo "==> Uploading arm64"
upload "$ARM_ZIP" "agent/$VERSION/RXVision-mac.zip" "$ARM_SHA"
upload "$ARM_ZIP" "agent/RXVision-mac.zip"          "$ARM_SHA"

echo "==> Uploading x64"
upload "$X64_ZIP" "agent/$VERSION/RXVision-mac-intel.zip" "$X64_SHA"
upload "$X64_ZIP" "agent/RXVision-mac-intel.zip"          "$X64_SHA"

echo
echo "Done. Set on the backend:"
echo "  AGENT_MAC_S3_KEY=agent/RXVision-mac.zip"
echo "  AGENT_MAC_X64_S3_KEY=agent/RXVision-mac-intel.zip"
echo "Macs on an older version pick up $VERSION on their next update check."
