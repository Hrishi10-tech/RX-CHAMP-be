# Signed agent updates (security review S-01)

Until this is set up, an agent installs any update whose SHA-256 matches what the API says, so
whoever can write the update file in storage can run code on every PC. With it set up, an agent
installs only an update signed with your key. The key never touches the server, storage or a
build machine.

## Once, on your own computer

1. `agent/build/signing/make-update-key.sh ~/rxvision-update-key` (any folder outside the repository).
2. Keep `update-signing-key.pem` offline and backed up. It is the only key that can sign updates.
   If it is lost, the next agent build needs a new key and a manual reinstall on every PC.
3. Copy `update-public-key.pem` to `agent/src/RXVision.Agent.Core/Update/update-public-key.pem`
   and commit that file (it is public). Every build from then on checks signatures.

## The guard: no key, no release build (audit F-01)

An agent without the key cannot be built or published by accident.

- A Release build of the agent stops with error RXV0001 while the public key file is missing.
  Debug builds (tests, local runs) are not held to it.
- `build-windows.sh` and `build-mac.sh` stop before they build and say what to do.
- For a test build only, pass `--unsigned-updates` to either build script (it sets the build
  property `RxvAllowUnsignedUpdates=true`). The script prints that the build must not go to
  people's machines, and the agent shows "Updates are not signed in this build." under its
  version, on the sign-in window and at the foot of the Profile tab.
- `publish-windows.sh` and `publish-mac.sh` refuse `--unsigned-updates`, stop while the key is
  missing, and refuse an agent that was built without the key, a reused payload or zip
  included. An unsigned build is never uploaded.
- Every build records which kind it is (`RxvUpdateSigning` in `RXVision.Agent.Core.dll`: `signed`
  or `unsigned`). The scripts read that back before they pack or upload.
- The key file must be the public half. An empty file, or one that holds a private key, stops
  the build (RXV0003).

An agent built without the key still installs updates on the server's checksum and says so in
its log. That is kept on purpose: see "The first signed release" below.

## Every release

Publish with the key at hand:

```bash
RXV_UPDATE_SIGNING_KEY=~/rxvision-update-key/update-signing-key.pem agent/build/publish-windows.sh --version 3.6.1
RXV_UPDATE_SIGNING_KEY=~/rxvision-update-key/update-signing-key.pem agent/build/publish-mac.sh --version 3.6.1
```

Both scripts sign before the SHA-256 is taken, and refuse to publish without the signing key.

## What is checked

The signature (ECDSA P-256, SHA-256) covers the platform, the version and the file's SHA-256, so a
signed build cannot be offered as another version or for the other platform. The agent strips the
signature and runs the checked copy; on Windows it holds that file open so nothing can swap it
before the installer starts (S-08).

## The first signed release

Agents built before the public key was added do not check signatures and take a signed file as
an ordinary update: on Windows the trailer sits after the installer, which ignores it; on macOS it
is the zip's comment, so the zip opens as before. From the first build that carries the key, every
later update must be signed.

Not covered here: Authenticode signing on Windows and Developer ID with notarisation on macOS. Both
need your certificates and remain the proper long-term fix.
