# Releasing DevHarbor

DevHarbor ships as a **code-signed, notarized** macOS app and auto-updates from
**GitHub Releases** via `electron-updater`. Releases are triggered by pushing a
`v*` tag - GitHub Actions builds, signs, notarizes, and publishes the artifacts.

## One-time setup

### 1. Apple Developer ID certificate
You need an active **Apple Developer Program** membership.

1. **Keychain Access → Certificate Assistant → Request a Certificate from a CA…**
   Save the CSR to disk (email + name; "Saved to disk").
2. <https://developer.apple.com/account/resources/certificates> → **+** →
   **Developer ID Application** → upload the CSR → download → double-click to install.
3. In Keychain Access, find the cert, expand it, select **both** the cert and its
   private key → right-click → **Export 2 items…** → save as `DeveloperID.p12`, set a password.
4. Note your **Team ID** (Membership page).
5. <https://appleid.apple.com> → Sign-In & Security → **App-Specific Passwords** →
   create one (used for notarization).

### 2. GitHub repository secrets
Repo: `jainath/devharbor` (public, so signed-out users can fetch updates).

Add under **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `MAC_CERTIFICATE_P12` | `base64 -i DeveloperID.p12 \| pbcopy` |
| `MAC_CERTIFICATE_PASSWORD` | the `.p12` password |
| `APPLE_ID` | your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password |
| `APPLE_TEAM_ID` | your Team ID |

`GITHUB_TOKEN` is provided automatically by Actions.

## Verify signing locally (before burning CI)

```bash
export CSC_LINK=/absolute/path/DeveloperID.p12 CSC_KEY_PASSWORD='p12-password'
export APPLE_ID='you@apple.id' APPLE_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx' APPLE_TEAM_ID='TEAMID'
pnpm pack:mac
spctl -a -vvv -t install "dist/mac-arm64/DevHarbor.app"   # expect: source=Notarized Developer ID
codesign -dv --verbose=4 "dist/mac-arm64/DevHarbor.app"   # Authority = Developer ID Application: <you>
```

## Cut a release

```bash
# 1. Bump version in package.json (semver) and update CHANGELOG.md.
# 2. Commit, then tag and push the tag:
git commit -am "release: v1.2.3"
git tag v1.2.3
git push origin main --tags
```

The `Release` workflow (`.github/workflows/release.yml`) runs on `macos-14`, builds
**arm64 + x64** (`--mac --arm64 --x64`), signs + notarizes, and creates
the GitHub Release with `*.dmg`, `*.zip`, `*.blockmap`, and `latest-mac.yml`.

> A guard step fails the workflow unless it was triggered by a `v*` **tag whose number
> matches `package.json` `version`** - so a stale version bump is caught before any
> signing/publishing happens.

### Dry-run the pipeline (no publish)

Trigger the workflow manually (**Actions → Release → Run workflow**, any branch). Manual
dispatch runs skip the tag guard and build with `--publish never`: the full
build + sign + notarize path is exercised and the artifacts are uploaded to the workflow
run (not to a Release). Use this to validate toolchain changes - runner images, action
versions, certificate renewals - without burning a version number.

### CI

`.github/workflows/ci.yml` runs typecheck, ESLint, and the test suite on every push/PR to
`main` (also on `macos-14`, so the native-module rebuild path matches the release runner).

## Verify after publish

1. Download the `arm64` (Apple Silicon) or `x64` (Intel) `.dmg` from the Release on a
   clean Mac - it should open **without** the right-click→Open bypass (proves notarization).
2. Auto-update: install the *previous* version, launch it, and confirm the in-app
   updater detects, downloads, and installs the new one. (Auto-update only works on
   **signed** builds - `squirrel.mac` verifies the Developer ID signature.)

## Artifacts & channels

- `latest-mac.yml` is the update feed; `electron-updater` reads the slice matching the
  running architecture.
- The download URLs are baked from `electron-builder.yml`'s `publish` block, so the
  `owner`/`repo` there must stay correct (`jainath/devharbor`).
