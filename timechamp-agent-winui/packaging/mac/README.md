# RX Vision agent for macOS

The macOS build of the RX Vision employee-monitoring agent: attendance, scheduled
breaks, activity sampling and screenshots, the same server contract as the Windows
agent. This folder holds the packaging inputs; `../build/build-mac.sh` turns a
`dotnet publish` into a signed `RX Vision.app` and zips it.

## What gets built

`build/build-mac.sh` produces two zips in `agent/dist/mac/`:

| Zip | Arch | Served as |
|---|---|---|
| `RXVision-mac.zip` | Apple Silicon (osx-arm64) | `GET /agent/download?platform=mac` |
| `RXVision-mac-intel.zip` | Intel (osx-x64) | `GET /agent/download?platform=mac-x64` |

Each contains `RX Vision.app`, a self-contained .NET 8 app (Avalonia UI, the
RX Vision core, and the macOS platform layer). The app is a menu-bar agent
(`LSUIElement`), so it has no Dock icon. `build/publish-mac.sh` uploads the zips
to S3 with `agent-version` / `agent-sha256` metadata, which is how the backend and
the agent's own self-update learn the current version.

Mac users never get an embedded enrollment token (that would break the code
signature). They sign in with email and password, or paste a setup code from the
portal (`GET /agent/setup-code`).

## Install (staff)

1. Download `RXVision-mac.zip` (Apple Silicon) or `RXVision-mac-intel.zip` (Intel).
   Not sure which: Apple menu > About This Mac. "Apple M1/M2/M3..." is Apple
   Silicon; "Intel" is Intel.
2. Double-click the zip to unpack `RX Vision.app`, then drag it into
   **Applications** before opening it. Always open it from Applications: a copy
   opened straight from Downloads runs from a temporary location, so it cannot
   start at login or update itself.
3. First launch depends on your macOS version:
   - **macOS 12 to 14 (Monterey, Ventura, Sonoma):** right-click (or
     Control-click) the app in Applications and choose **Open**, then **Open**
     again in the dialog. Doing it from the right-click menu is what lets an
     unsigned app through the first time.
   - **macOS 15+ (Sequoia and later):** double-click it once. macOS blocks it
     ("Apple could not verify..."); click **Done**. Open **System Settings >
     Privacy & Security**, scroll down to **Security**, and click **Open Anyway**
     next to the RX Vision message (it is offered for about an hour after the
     blocked attempt). Click **Open Anyway** again in the dialog that follows and
     confirm with Touch ID or your password.
4. **Grant Screen Recording** (needed for screenshots and for reading window
   titles): click **Allow screen recording** on the banner in the RX Vision
   dashboard, then turn RX Vision on in **System Settings > Privacy & Security >
   Screen Recording** (called **Screen & System Audio Recording** on macOS 15).
   macOS only reads this permission at launch, so **Quit RX Vision and open it
   again**. Until you do, no screenshots are taken and window titles are blank.
   On macOS 15, macOS asks again about once a month whether RX Vision may keep
   recording the screen; choose **Allow**.
5. **Allow Automation per browser.** The first time the agent reads the address
   bar of a browser (Safari, Chrome, Edge, Brave, Arc, Vivaldi, Opera), macOS asks
   to allow RX Vision to control that browser. Click **OK**. If you decline, the
   website host is simply left out for that browser; nothing else is affected.
   (Firefox cannot be read this way and is always left out.)

Nothing here needs an administrator unless your IT team has locked down
Applications.

**After an automatic update (ad-hoc build).** macOS ties Screen Recording and
Keychain access to the exact build of an ad-hoc signed app, so after RX Vision
updates itself:

- macOS may ask for your login password because "RX Vision wants to use your
  confidential information stored in com.rxvision.agent". Enter it and click
  **Always Allow** (plain Allow asks again at every launch).
- If the dashboard shows the screen-recording banner again although RX Vision
  is still ticked in Settings, turn RX Vision off and on again there (or remove
  it with the minus button and add it back), then Quit and reopen RX Vision.

A Developer ID signed build (below) keeps both across updates.

## Permission model, step by step

| Permission | When it is asked | If denied |
|---|---|---|
| Screen Recording | When you click **Allow screen recording** on the dashboard banner | No screenshots; window titles are dropped. Grant it, then Quit and reopen. |
| Automation (per browser) | The first time the browser is in front and the agent reads the URL | That browser's website host is left out; the agent backs off that browser for 10 minutes before asking again. |
| Accessibility | Not requested | Not required. The agent reports its state only. |
| Start at login | Set automatically after sign-in (a LaunchAgent) | Enabled on sign-in, removed on sign-out. Takes effect at next login. |

Idle time and lock/unlock need no permission.

## IT pre-approval via MDM

Screen Recording and Automation can be pre-granted so staff never see a prompt,
using a **PPPC** (Privacy Preferences Policy Control) profile pushed from your MDM
(Jamf, Kandji, Intune, etc.). The payload identifies the app by its bundle ID and
its **code requirement**, which means:

> A PPPC profile can only pre-approve a **Developer ID signed** app. The default
> ad-hoc build cannot be pre-approved; its signature has no stable team identity
> for the profile to match.

To pre-approve, first produce a Developer ID signed + notarized build (below),
then in the PPPC payload:

- Identifier: `com.rxvision.agent`, type **bundleID**.
- Code requirement: `identifier "com.rxvision.agent" and anchor apple generic and certificate leaf[subject.OU] = "<YOUR_TEAM_ID>"`.
- Services: `ScreenCapture` = Allow. (`AppleEvents` for per-browser Automation is
  allowed with the source `com.rxvision.agent` and the destination set to each
  browser's bundle ID, e.g. `com.google.Chrome`.)

## Signing and notarizing properly (production)

The default build is **ad-hoc** signed: it runs after the quarantine steps above,
but Gatekeeper treats it as an unidentified developer and it cannot be
notarized or pre-approved by MDM. For a fleet rollout, sign with an Apple
**Developer ID Application** certificate and notarize.

`build/build-mac.sh` takes the Developer ID path automatically when these env
vars are set (it uses the bundled `rcodesign`, so it still runs off a Mac):

```
export MAC_SIGN_P12=/path/to/DeveloperID.p12
export MAC_SIGN_P12_PASSWORD=...                     # the .p12 password
export MAC_NOTARY_API_KEY_FILE=/path/to/api-key.json # see below
./build/build-mac.sh
```

The API key JSON comes from an App Store Connect API key (Issuer ID + Key ID +
the `.p8`), encoded once with:

```
rcodesign encode-app-store-connect-api-key <issuer-id> <key-id> /path/AuthKey_<key-id>.p8 > api-key.json
```

That path signs with hardened runtime + `entitlements.plist`, submits to Apple's
notary service and staples the ticket.

### Caveat: managed assemblies and the signer

This app is a .NET bundle: ~200 non-Mach-O files (managed `.dll`s, `.json`,
`.pdb`, `Assets/`) sit in `Contents/MacOS` beside the apphost. `rcodesign` 0.29
signs every Mach-O (the apphost and the native `.dylib`s) but does **not** seal
those files into `CodeResources` (it prints "non Mach-O file with a nested rule"
for each and skips it). Apple's validator then reports every one as "file added":
the bundle's seal is invalid, and Gatekeeper shows a quarantined copy as
"damaged" instead of offering Open / Open Anyway.

`build/build-mac.sh` therefore seals them itself after signing (each as a plain
resource with its SHA-1 and SHA-256, the form `codesign` uses for data files),
re-signs the main executable so it binds the completed `CodeResources` and
`Info.plist`, and fails the build if any file in the bundle is unsealed or does
not match its seal. On a Mac, confirm a build with:

```
codesign --verify --deep --strict --verbose=2 "RX Vision.app"   # valid on disk, satisfies its Designated Requirement
spctl --assess --type execute -vv "RX Vision.app"               # ad-hoc: "rejected" is expected; it must not say the seal is broken
```

The Developer ID path gets the same sealing, but it has not been notarized from
this build box. If Apple's notary rejects it, sign and notarize on a Mac with
Apple's own tooling instead:

```
codesign --deep --force --options runtime \
  --entitlements packaging/mac/entitlements.plist \
  --sign "Developer ID Application: <Your Org> (<TEAMID>)" "RX Vision.app"
ditto -c -k --keepParent "RX Vision.app" RXVision-mac.zip
xcrun notarytool submit RXVision-mac.zip --apple-id <id> --team-id <TEAMID> --password <app-specific-pw> --wait
xcrun stapler staple "RX Vision.app"
```

Then re-zip the stapled app for distribution. `build/publish-mac.sh` uploads
whatever zips are already in `agent/dist/mac/`, so a Mac-signed zip drops straight
in. Notarization cannot be exercised on the Linux build box; treat this path as
documented-not-tested until run once on a Mac.

## Build and publish

```
# Build both arch zips into agent/dist/mac/ (ad-hoc by default)
./build/build-mac.sh

# Build then upload to S3 (versioned key + stable latest key, with checksums)
./build/publish-mac.sh                 # reads version from Directory.Build.props
./build/publish-mac.sh --no-upload     # build + checksum only
./build/publish-mac.sh --skip-build    # upload the existing zips
```

After upload, point the backend at the latest keys:

```
AGENT_MAC_S3_KEY=agent/RXVision-mac.zip
AGENT_MAC_X64_S3_KEY=agent/RXVision-mac-intel.zip
```

## Troubleshooting

- **Screenshots are blank.** Screen Recording is off or was granted while the app
  was already running. Tick RX Vision in **System Settings > Privacy & Security >
  Screen Recording**, then **Quit and reopen** RX Vision.
- **"RX Vision is damaged and can't be opened" / "cannot be opened because the
  developer cannot be verified".** This is the quarantine flag on an unsigned or
  ad-hoc copy (with "damaged", the copy's signature also failed to check, for
  example a zip from an older build). Remove it:
  ```
  xattr -dr com.apple.quarantine "/Applications/RX Vision.app"
  ```
  Then open the app again. (A Developer ID signed + notarized build does not show
  this.)
- **A browser's website is never recorded.** Automation was declined for that
  browser, or it is Firefox (not scriptable). Re-enable it in **System Settings >
  Privacy & Security > Automation** under RX Vision. The agent backs off a declined
  browser for 10 minutes.
- **It did not start at login.** The LaunchAgent is written on sign-in and applies
  at the next login, not immediately. Check
  `~/Library/LaunchAgents/com.rxvision.agent.plist` exists. It is not written
  while the app runs from Downloads (see Install step 2): move it to
  Applications and open it from there. On macOS 13+, also check **System
  Settings > General > Login Items > Allow in the Background**: the RX Vision
  entry (it may show as "RXVision") must be on.
- **Logs.** `~/Library/Logs/RXVision/` holds `agent.log` (app), `agent-mac.log`
  (platform layer: permissions, keychain fallbacks, capture) and `update.log`
  (self-update swaps). Data lives in `~/Library/Application Support/RXVision`;
  scratch and downloads in `~/Library/Caches/RXVision`.
