#!/usr/bin/env bash
#
# Builds "RX Vision.app" for Apple Silicon and Intel, signs each bundle, and zips
# them into agent/dist/mac/ ready for publish-mac.sh to upload.
#
# Runs on macOS (for a real release) OR on Linux (rcodesign signs Mach-O without a
# Mac, and `dotnet publish` cross-targets osx-*). The ad-hoc path needs no Apple
# account and is what staff get today; the Developer ID path (env below) produces
# a signed + notarized build and is documented in packaging/mac/README.md.
#
# Output (matches what the backend serves and what UpdateService downloads):
#   agent/dist/mac/RXVision-mac.zip        (osx-arm64, ?platform=mac)
#   agent/dist/mac/RXVision-mac-intel.zip  (osx-x64,   ?platform=mac-x64)
#
# Option: --api-hosts <a,b> (or RXV_API_HOSTS): the API hosts this build may talk to (review
# AG-2). Not given: production alone (api.rxvision.shop). A staging or pilot build names its
# hosts on purpose; the first one is where a fresh install signs in.
#
# Option: --unsigned-updates: a test build without the owner's update-signing key (audit F-01).
# Such an agent installs whatever update the server offers, says "Updates are not signed in this
# build." beside its version, and must not go to people's machines. Without this option the
# script stops when the public key is not in the source.
#
# Override points (env):
#   RXV_APP_CSPROJ  path to the app csproj (default src/RXVision.Agent/...)
#   RCODESIGN       rcodesign binary (default: on PATH)
#   MAC_SIGN_P12 / MAC_SIGN_P12_PASSWORD           Developer ID .p12 + password
#   MAC_NOTARY_API_KEY_FILE                        App Store Connect API key JSON
#                                                  (from `rcodesign encode-app-store-connect-api-key`)
set -euo pipefail

API_HOSTS="${RXV_API_HOSTS:-}"
UNSIGNED_UPDATES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-hosts) API_HOSTS="$2"; shift 2;;
    --unsigned-updates) UNSIGNED_UPDATES=1; shift;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done

# Audit F-01: an agent that goes to people must check update signatures, so it is built with the
# owner's public key in the source. Without the key the script stops before it builds anything,
# unless the build was asked for as a test build (--unsigned-updates).
UPDATE_KEY="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/src/RXVision.Agent.Core/Update/update-public-key.pem"
UNSIGNED_PROP=()
if [[ -f "$UPDATE_KEY" ]]; then
  if [[ "$UNSIGNED_UPDATES" -eq 1 ]]; then
    echo "NOTE: --unsigned-updates has no effect: the update key is in the source, so this build checks update signatures." >&2
    UNSIGNED_UPDATES=0
  fi
elif [[ "$UNSIGNED_UPDATES" -eq 1 ]]; then
  printf '\n*** UPDATES ARE NOT SIGNED IN THIS BUILD: a test build, it must not go to people'"'"'s machines ***\n\n' >&2
  UNSIGNED_PROP=("-p:RxvAllowUnsignedUpdates=true")
else
  cat >&2 <<EOF
ERROR: the update-signing public key is not in the source:
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
fi
HOSTS_PROP=()
if [[ -n "$API_HOSTS" ]]; then
  printf '\n*** NOT A PRODUCTION BUILD: this agent talks to %s ***\n\n' "$API_HOSTS" >&2
  # %2C: a comma inside an MSBuild property given on the command line.
  HOSTS_PROP=("-p:RxvAllowedApiHosts=${API_HOSTS//,/%2C}")
fi

APP_NAME="RX Vision"
EXE_NAME="RXVision"
BUNDLE_ID="com.rxvision.agent"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG="$AGENT_DIR/packaging/mac"
DIST="$AGENT_DIR/dist/mac"
APP_CSPROJ="${RXV_APP_CSPROJ:-$AGENT_DIR/src/RXVision.Agent/RXVision.Agent.csproj}"
RCODESIGN="${RCODESIGN:-rcodesign}"

# One version for the whole agent, read from the single place it is declared.
VERSION="$(grep -oE '<Version>[^<]+' "$AGENT_DIR/Directory.Build.props" | head -1 | sed -E 's/.*<Version>//')"
[ -n "$VERSION" ] || { echo "ERROR: could not read <Version> from Directory.Build.props" >&2; exit 1; }

echo "RX Vision mac build"
echo "  app csproj : $APP_CSPROJ"
echo "  version    : $VERSION"
echo "  rcodesign  : $("$RCODESIGN" --version 2>/dev/null || echo "NOT FOUND")"
[ -f "$APP_CSPROJ" ] || { echo "ERROR: app csproj not found: $APP_CSPROJ" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 is required (seals and checks the bundle's CodeResources)" >&2; exit 1; }

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  else sha256sum "$1" | awk '{print $1}'; fi
}
filesize() { wc -c < "$1" | tr -d ' '; }

check_signed() {
  local path="$1" label="$2" info
  info="$("$RCODESIGN" print-signature-info "$path" 2>/dev/null || true)"
  # A signed Mach-O reports a code_directory block with a code signing hash.
  if printf '%s' "$info" | grep -qiE 'code_directory|cdhash|CMS Signature'; then
    local ident
    ident="$(printf '%s' "$info" | grep -iE 'identifier:' | head -1 | sed -E 's/.*identifier:[[:space:]]*//' || true)"
    echo "    $label: signed (identifier ${ident:-unknown})"
  else
    echo "ERROR: $label is not signed" >&2
    printf '%s\n' "$info" >&2
    exit 1
  fi
}

sign_adhoc() {
  local app="$1" log="$2"
  echo "  signing (ad-hoc)"
  # rcodesign warns on every managed .dll under Contents/MacOS ("non Mach-O file
  # with a nested rule") because that directory is where it expects Mach-O; it
  # signs every real Mach-O but leaves those files unsealed, which
  # seal_bundle_resources fixes next. Keep the console readable by routing the
  # chatter to a log and summarising.
  if ! "$RCODESIGN" sign "$app" >"$log" 2>&1; then
    echo "  ERROR: ad-hoc signing failed:" >&2
    cat "$log" >&2
    return 1
  fi
  local signed nested
  signed="$(grep -c 'signing Mach-O file' "$log" || true)"
  nested="$(grep -c 'non Mach-O file with a nested rule' "$log" || true)"
  echo "    signed $signed Mach-O file(s); $nested non Mach-O file(s) left for the resource seal"
}

sign_developer_id() {
  local app="$1" log="$2"
  echo "  signing (Developer ID + hardened runtime + entitlements)"
  "$RCODESIGN" sign \
    --p12-file "$MAC_SIGN_P12" \
    --p12-password "$MAC_SIGN_P12_PASSWORD" \
    --for-notarization \
    --entitlements-xml-file "Contents/MacOS/$EXE_NAME:$PKG/entitlements.plist" \
    "$app" 2>&1 | tee "$log"
}

notarize_developer_id() {
  local app="$1"
  if [ -n "${MAC_NOTARY_API_KEY_FILE:-}" ]; then
    echo "  notarizing + stapling (this can take a minute)"
    "$RCODESIGN" notary-submit --api-key-file "$MAC_NOTARY_API_KEY_FILE" --staple "$app"
  else
    echo "  WARNING: MAC_NOTARY_API_KEY_FILE not set; signed but NOT notarized" >&2
  fi
}

# rcodesign 0.29 signs every Mach-O, but it cannot classify the non-Mach-O files
# .NET puts in Contents/MacOS (managed .dll, .json, .pdb, Assets/*): it warns
# "non Mach-O file with a nested rule" and leaves them OUT of CodeResources.
# Apple's validator then reports each one as "file added", so the bundle's seal
# is invalid and Gatekeeper calls a quarantined copy "damaged" (no Open Anyway).
# Seal them as plain resources (hash + hash2, as codesign records data files) and
# re-sign only the main executable, so its CodeDirectory binds the completed
# CodeResources and Info.plist. The nested dylib seals are left as rcodesign made them.
seal_bundle_resources() {
  local app="$1" log="$2"
  local added
  added="$(python3 -I - "$app" "$EXE_NAME" <<'PY'
import hashlib, os, plistlib, sys
app, exe = sys.argv[1], sys.argv[2]
contents = os.path.join(app, "Contents")
cr_path = os.path.join(contents, "_CodeSignature", "CodeResources")
with open(cr_path, "rb") as f:
    cr = plistlib.load(f)
files2 = cr["files2"]
macho = {b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf"}
added = 0
for root, dirs, names in os.walk(contents):
    dirs[:] = [d for d in dirs if not (root == contents and d == "_CodeSignature")]
    for n in names:
        p = os.path.join(root, n)
        rel = os.path.relpath(p, contents).replace(os.sep, "/")
        if rel in ("Info.plist", "PkgInfo", "MacOS/" + exe) or n == ".DS_Store" or rel in files2:
            continue
        if os.path.islink(p):
            sys.exit("unsealed symlink in bundle: " + rel)
        with open(p, "rb") as f:
            data = f.read()
        if data[:4] in macho:
            sys.exit("Mach-O left unsigned by rcodesign: " + rel)
        files2[rel] = {"hash": hashlib.sha1(data).digest(), "hash2": hashlib.sha256(data).digest()}
        added += 1
with open(cr_path, "wb") as f:
    plistlib.dump(cr, f, fmt=plistlib.FMT_XML)
print(added)
PY
)"
  local identity=()
  if [ -n "${MAC_SIGN_P12:-}" ] && [ -n "${MAC_SIGN_P12_PASSWORD:-}" ]; then
    identity=(--p12-file "$MAC_SIGN_P12" --p12-password "$MAC_SIGN_P12_PASSWORD"
              --for-notarization --entitlements-xml-file "$PKG/entitlements.plist")
  fi
  # ${a[@]+...}: an empty array is "unbound" under set -u in macOS's bash 3.2.
  if ! "$RCODESIGN" sign ${identity[@]+"${identity[@]}"} \
      --binary-identifier "$BUNDLE_ID" \
      --info-plist-file "$app/Contents/Info.plist" \
      --code-resources-file "$app/Contents/_CodeSignature/CodeResources" \
      "$app/Contents/MacOS/$EXE_NAME" >>"$log" 2>&1; then
    echo "  ERROR: re-signing the main executable failed:" >&2
    tail -20 "$log" >&2
    return 1
  fi
  echo "    sealed $added managed/data file(s) under Contents as resources; main executable re-signed"
}

# The resource half of Apple's static check, so a broken seal fails the build here
# instead of showing staff "damaged": every file under Contents is sealed, every
# plain seal matches, and the main executable binds this Info.plist and CodeResources.
check_bundle_seal() {
  local app="$1"
  local info
  info="$("$RCODESIGN" print-signature-info "$app/Contents/MacOS/$EXE_NAME" 2>/dev/null || true)"
  printf '%s' "$info" | python3 -I -c '
import hashlib, os, plistlib, re, sys
app, exe, bundle_id, version = sys.argv[1:5]
info = sys.stdin.read()
contents = os.path.join(app, "Contents")
cr_bytes = open(os.path.join(contents, "_CodeSignature", "CodeResources"), "rb").read()
files2 = plistlib.loads(cr_bytes)["files2"]
bad = []
on_disk = set()
for root, dirs, names in os.walk(contents):
    dirs[:] = [d for d in dirs if not (root == contents and d == "_CodeSignature")]
    for n in names:
        rel = os.path.relpath(os.path.join(root, n), contents).replace(os.sep, "/")
        if rel not in ("Info.plist", "PkgInfo", "MacOS/" + exe) and n != ".DS_Store":
            on_disk.add(rel)
bad += ["file added: " + r for r in sorted(on_disk - set(files2))]
bad += ["file missing: " + r for r in sorted(set(files2) - on_disk)]
for r in sorted(on_disk & set(files2)):
    seal = files2[r]
    if "cdhash" not in seal and hashlib.sha256(open(os.path.join(contents, r), "rb").read()).digest() != seal.get("hash2"):
        bad.append("modified: " + r)
def slot(name):
    m = re.search(name + r" \(\d\): ([0-9a-f]{64})", info)
    return m.group(1) if m else None
if slot("Info") != hashlib.sha256(open(os.path.join(contents, "Info.plist"), "rb").read()).hexdigest():
    bad.append("main executable does not bind Info.plist")
if slot("Resources") != hashlib.sha256(cr_bytes).hexdigest():
    bad.append("main executable does not bind CodeResources")
if "identifier: " + bundle_id not in info:
    bad.append("main executable identifier is not " + bundle_id)
plist = plistlib.load(open(os.path.join(contents, "Info.plist"), "rb"))
for key, want in (("CFBundleExecutable", exe), ("CFBundleIdentifier", bundle_id),
                  ("CFBundleShortVersionString", version), ("CFBundleVersion", version), ("LSUIElement", True)):
    if plist.get(key) != want:
        bad.append("Info.plist %s is %r, expected %r" % (key, plist.get(key), want))
for b in bad[:20]:
    print("ERROR: " + b, file=sys.stderr)
if bad:
    sys.exit(1)
print("    resource seal complete: %d files sealed and bound to the main executable" % len(on_disk))
' "$app" "$EXE_NAME" "$BUNDLE_ID" "$VERSION"
}

build_one() {
  local rid="$1" zipname="$2"
  echo
  echo "==> $rid -> $zipname"
  local work pub app
  work="$(mktemp -d)"
  pub="$work/publish"
  app="$work/$APP_NAME.app"

  # Self-contained, NOT single-file: Avalonia/Skia native libs must sit next to
  # the managed binaries inside Contents/MacOS.
  dotnet publish "$APP_CSPROJ" -c Release -r "$rid" --self-contained true \
    -p:UseAppHost=true -p:PublishSingleFile=false ${HOSTS_PROP[@]+"${HOSTS_PROP[@]}"} \
    ${UNSIGNED_PROP[@]+"${UNSIGNED_PROP[@]}"} --nologo -o "$pub"

  # What goes into the bundle says itself whether it checks update signatures (the build bakes
  # RxvUpdateSigning into RXVision.Agent.Core.dll: the name, one length byte, the value).
  if [[ "$UNSIGNED_UPDATES" -eq 0 ]]; then
    local signed
    signed="$(LC_ALL=C grep -a -c 'RxvUpdateSigning.signed' "$pub/RXVision.Agent.Core.dll" || true)"
    [[ "${signed:-0}" -ge 1 ]] || { echo "ERROR: the agent just built does not check update signatures; not packing it" >&2; exit 1; }
  fi

  [ -f "$pub/$EXE_NAME" ] || { echo "ERROR: publish produced no $EXE_NAME apphost (is AssemblyName=$EXE_NAME?)" >&2; exit 1; }

  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  cp -R "$pub/." "$app/Contents/MacOS/"
  sed "s/__VERSION__/$VERSION/g" "$PKG/Info.plist" > "$app/Contents/Info.plist"
  cp "$PKG/RXVision.icns" "$app/Contents/Resources/$EXE_NAME.icns"
  chmod +x "$app/Contents/MacOS/$EXE_NAME"

  # PkgInfo is optional but conventional for an APPL bundle.
  printf 'APPL????' > "$app/Contents/PkgInfo"

  local signlog="$work/sign.log"
  if [ -n "${MAC_SIGN_P12:-}" ] && [ -n "${MAC_SIGN_P12_PASSWORD:-}" ]; then
    sign_developer_id "$app" "$signlog"
    seal_bundle_resources "$app" "$signlog"
    notarize_developer_id "$app"
  else
    sign_adhoc "$app" "$signlog"
    seal_bundle_resources "$app" "$signlog"
  fi

  # rcodesign's `verify` is self-flagged as buggy in 0.29 and on a bundle only
  # accepts a Mach-O; confirm the signature with print-signature-info instead,
  # which reports the sealed CodeDirectory for the main executable and a nested
  # dylib. (On a Mac, `codesign --verify --deep` is the authoritative check; see
  # packaging/mac/README.md.)
  [ -d "$app/Contents/_CodeSignature" ] || { echo "ERROR: bundle was not signed (no _CodeSignature)" >&2; exit 1; }
  echo "  inspecting signature"
  check_signed "$app/Contents/MacOS/$EXE_NAME" "main executable"
  if [ -f "$app/Contents/MacOS/libSkiaSharp.dylib" ]; then
    check_signed "$app/Contents/MacOS/libSkiaSharp.dylib" "libSkiaSharp.dylib"
  fi
  check_bundle_seal "$app"

  mkdir -p "$DIST"
  rm -f "$DIST/$zipname"
  # -y keep symlinks as symlinks, -r recurse, -X drop extra attrs. Unix perms
  # (the +x on the apphost) are preserved by Info-ZIP.
  ( cd "$work" && zip -y -r -X "$DIST/$zipname" "$APP_NAME.app" >/dev/null )

  local size sha
  size="$(filesize "$DIST/$zipname")"
  sha="$(sha256 "$DIST/$zipname")"
  echo "  built $DIST/$zipname"
  echo "    size   : $size bytes ($(( size / 1024 / 1024 )) MB)"
  echo "    sha256 : $sha"

  rm -rf "$work"
}

build_one osx-arm64 RXVision-mac.zip
build_one osx-x64   RXVision-mac-intel.zip

echo
echo "Done. Zips in $DIST"
if [[ "$UNSIGNED_UPDATES" -eq 1 ]]; then
  echo "NOT FOR RELEASE: updates are not signed in this build (--unsigned-updates). publish-mac.sh will not upload it."
else
  echo "Next: build/publish-mac.sh uploads them to S3 (version $VERSION)."
fi
