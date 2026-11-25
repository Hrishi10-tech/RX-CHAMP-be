#!/usr/bin/env bash
# Builds the Windows agent installer (via build-windows.sh) and uploads it to S3,
# exactly where the backend serves it from and in the same shape as the old
# scripts/publish-agent.ps1: a versioned key and the stable "latest" key, each
# stamped with the version and SHA-256 as S3 object metadata (agent-version,
# agent-sha256). That metadata is how GET /api/v1/agent/version tells agents in the
# field what the current build is and what its bytes should hash to. Uploading IS
# the release: there is no backend env to change afterwards.
#
# Credentials: the AWS CLI's own chain (CI secrets, instance role, aws configure);
# for local dev it falls back to AWS_* in the backend .env, like the PowerShell script.
#
# Options (all optional):
#   --bucket <name>   S3 bucket   (default: rx-timechamp)
#   --region <name>   S3 region   (default: ap-south-1)
#   --version <x>     must equal <Version> in Directory.Build.props (the default); a mismatch is refused
#   --stub            build a stand-in payload (see build-windows.sh)
#   --real            require the real app project
#   --skip-app        reuse the existing payload/app.zip
#   --no-upload       build only; do not touch S3
#
# Audit F-01: only an agent that checks update signatures is published. The script stops before
# it builds when the owner's public key is not in the source, and it does not take
# --unsigned-updates: a test build made with build-windows.sh --unsigned-updates stays on the
# machine that made it.
set -euo pipefail

BUCKET="rx-timechamp"
REGION="ap-south-1"
VERSION=""
NO_UPLOAD=0
BUILD_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket) BUCKET="$2"; shift 2;;
    --region) REGION="$2"; shift 2;;
    --version) VERSION="$2"; shift 2;;
    --no-upload) NO_UPLOAD=1; shift;;
    --stub|--real|--skip-app) BUILD_ARGS+=("$1"); shift;;
    --unsigned-updates) echo "ERROR: --unsigned-updates is refused here: an unsigned build is never published. For a test build use build/build-windows.sh --unsigned-updates." >&2; exit 2;;
    -c) BUILD_ARGS+=("$1" "$2"); shift 2;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$AGENT_ROOT/.." && pwd)"
OUT_EXE="$AGENT_ROOT/dist/windows/RXChampAgent.exe"
BUILD_PROPS="$AGENT_ROOT/Directory.Build.props"

if [[ -z "$VERSION" ]]; then
  # Read <Version> from Directory.Build.props, the single place it is declared.
  VERSION="$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' "$BUILD_PROPS" | head -n1 | tr -d '[:space:]')"
  [[ -n "$VERSION" ]] || { echo "ERROR: no <Version> in $BUILD_PROPS; pass --version." >&2; exit 1; }
  echo "Version $VERSION (from Directory.Build.props)"
fi
# The build inside is always <Version> from Directory.Build.props; a different
# label would make every agent download it, find the old version inside, and
# refuse it. So --version may only restate it.
PROPS_VERSION="$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' "$BUILD_PROPS" | head -n1 | tr -d '[:space:]')"
if [[ "${VERSION#v}" != "$PROPS_VERSION" ]]; then
  echo "ERROR: --version $VERSION does not match <Version>$PROPS_VERSION</Version> in $BUILD_PROPS; bump it there instead." >&2
  exit 1
fi
VERSION="$PROPS_VERSION"

# Audit F-01: without the owner's public key the agent would install any update the server
# offers, so nothing is built or uploaded from here. (build-windows.sh then reads the payload
# back and stops if the agent in it, a reused one included, was built without the key.)
PUBLIC_KEY="$AGENT_ROOT/src/RXVision.Agent.Core/Update/update-public-key.pem"
if [[ ! -f "$PUBLIC_KEY" ]]; then
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

# 1-5. Build the installer.
bash "$SCRIPT_DIR/build-windows.sh" "${BUILD_ARGS[@]}"
[[ -f "$OUT_EXE" ]] || { echo "ERROR: $OUT_EXE was not produced." >&2; exit 1; }

# Security review S-01: sign the installer with the owner's offline key before the SHA-256 is
# taken. A build that carries the public key installs only signed updates, so it is never
# published unsigned.
if [[ -n "${RXV_UPDATE_SIGNING_KEY:-}" ]]; then
  bash "$SCRIPT_DIR/signing/sign-update.sh" "$OUT_EXE" windows "$VERSION" "$RXV_UPDATE_SIGNING_KEY"
elif [[ -f "$PUBLIC_KEY" ]]; then
  echo "ERROR: this build checks update signatures; set RXV_UPDATE_SIGNING_KEY to the signing key (build/signing/README.md)." >&2
  exit 1
fi

SHA256="$(sha256sum "$OUT_EXE" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$OUT_EXE" | cut -d' ' -f1)"

if [[ "$NO_UPLOAD" -eq 1 ]]; then
  echo "--no-upload set; built $OUT_EXE (sha256 $SHA256). Nothing uploaded."
  exit 0
fi

# Credentials fallback from the backend .env, mirroring publish-agent.ps1.
if [[ -z "${AWS_ACCESS_KEY_ID:-}" && -f "$REPO_ROOT/backend/.env" ]]; then
  while IFS='=' read -r key val; do
    case "$key" in
      AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_REGION)
        val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
        export "$key"="$(echo "$val" | xargs)";;
    esac
  done < "$REPO_ROOT/backend/.env"
fi

VERSIONED_KEY="agent/$VERSION/RXChampAgent.exe"
LATEST_KEY="agent/RXChampAgent.exe"
META="agent-version=$VERSION,agent-sha256=$SHA256"
echo "  version $VERSION  sha256 $SHA256"

echo "==> Uploading to s3://$BUCKET/$VERSIONED_KEY and /$LATEST_KEY"
aws s3 cp "$OUT_EXE" "s3://$BUCKET/$VERSIONED_KEY" --region "$REGION" --metadata "$META" --only-show-errors
aws s3 cp "$OUT_EXE" "s3://$BUCKET/$LATEST_KEY" --region "$REGION" --metadata "$META" --only-show-errors

echo "Done. Agents on an older version pick $VERSION up on their next check."
echo "Backend should have AGENT_S3_KEY=$LATEST_KEY (or $VERSIONED_KEY to pin)."
