#!/usr/bin/env bash
# Creates the owner's update-signing key pair (security review S-01). Run once, on the owner's
# own machine, never on a build server:
#   agent/build/signing/make-update-key.sh <folder outside the repository>
# Writes update-signing-key.pem (PRIVATE: keep it offline, back it up, never commit or upload it)
# and update-public-key.pem. Copy only the public key to
# agent/src/RXVision.Agent.Core/Update/update-public-key.pem and rebuild: from then on that build
# installs only updates signed with this key (sign-update.sh).
set -euo pipefail
out="${1:?usage: make-update-key.sh <folder outside the repository>}"
mkdir -p "$out"
umask 077
[ -e "$out/update-signing-key.pem" ] && { echo "refusing: $out/update-signing-key.pem exists" >&2; exit 2; }
openssl ecparam -name prime256v1 -genkey -noout -out "$out/update-signing-key.pem"
openssl ec -in "$out/update-signing-key.pem" -pubout -out "$out/update-public-key.pem" 2>/dev/null
echo "private key: $out/update-signing-key.pem (keep offline)"
echo "public key:  $out/update-public-key.pem (copy into agent/src/RXVision.Agent.Core/Update/)"
