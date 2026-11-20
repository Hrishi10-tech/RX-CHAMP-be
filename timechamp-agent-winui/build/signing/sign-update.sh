#!/usr/bin/env bash
# Signs an agent update in place (security review S-01): appends the trailer the agent checks
# before it installs anything (src/RXVision.Agent.Core/Update/UpdateSignature.cs).
#   agent/build/signing/sign-update.sh <file> <windows|mac> <version> <update-signing-key.pem>
# Run it on the finished RXChampAgent.exe or RXVision-mac*.zip, before the SHA-256 is taken and
# before upload (publish-windows.sh and publish-mac.sh do this when RXV_UPDATE_SIGNING_KEY is set).
set -euo pipefail
file="${1:?file}"; platform="${2:?windows or mac}"; version="${3:?version}"; key="${4:?private key}"
case "$platform" in windows|mac) ;; *) echo "platform must be windows or mac" >&2; exit 2 ;; esac
version="${version#v}"; version="${version%%[-+]*}"
magic="RXVSIG01"
if [ "$(tail -c 8 "$file" | od -An -c | tr -d ' \n')" = "$magic" ]; then echo "refusing: $file is already signed" >&2; exit 2; fi
sha="$(openssl dgst -sha256 -r "$file" | cut -d' ' -f1)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
printf '%s\n%s\n%s\n%s' "$magic" "$platform" "$version" "$sha" > "$tmp/message"
openssl dgst -sha256 -sign "$key" -out "$tmp/sig" "$tmp/message"
siglen=$(wc -c < "$tmp/sig" | tr -d ' ')
verlen=$(printf '%s' "$version" | wc -c | tr -d ' ')
le16() { printf "\\$(printf '%03o' $(( $1 & 255 )))\\$(printf '%03o' $(( ($1 >> 8) & 255 )))"; }
{ cat "$tmp/sig"; printf '%s' "$version"; le16 "$verlen"; le16 "$siglen"; printf '%s' "$magic"; } > "$tmp/trailer"
if [ "$platform" = mac ]; then
  # The trailer becomes the zip's comment, so the zip stays valid for ditto and every unzip:
  # the end-of-central-directory record must be the last 22 bytes, with no comment yet.
  size=$(wc -c < "$file" | tr -d ' ')
  eocd="$(tail -c 22 "$file" | head -c 4 | od -An -tx1 | tr -d ' \n')"
  clen="$(tail -c 2 "$file" | od -An -tx1 | tr -d ' \n')"
  [ "$eocd" = "504b0506" ] && [ "$clen" = "0000" ] || { echo "refusing: $file has a zip comment or no end record" >&2; exit 2; }
  tlen=$(wc -c < "$tmp/trailer" | tr -d ' ')
  le16 "$tlen" | dd of="$file" bs=1 seek=$((size - 2)) conv=notrunc status=none
fi
cat "$tmp/trailer" >> "$file"
echo "signed $file for $platform $version (payload sha256 $sha)"
