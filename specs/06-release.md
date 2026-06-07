# 06 — Release (macOS)

How to ship a signed, notarized, auto-updating DMG.

This document is the prerequisite list and runbook for actually shipping. Most of it is one-time setup; once the secrets are in place, releases are `git tag v0.1.1 && git push --tags`.

## One-time prerequisites

### Apple side

1. **Apple Developer account** — $99 USD/year. https://developer.apple.com/
2. **Developer ID Application certificate** — Xcode → Settings → Accounts → "Manage Certificates" → `+` → **Developer ID Application**. Export from Keychain Access as a `.p12` with a strong password.
3. **App-specific password** for notarization — sign in to https://appleid.apple.com → "Sign-In and Security" → "App-Specific Passwords" → generate one. Save it.
4. **Team ID** — at https://developer.apple.com/account → Membership Details (10-char alphanumeric).

### GitHub side

5. **A public repo** at `github.com/<owner>/<repo>` matching the `publish` block of [electron-builder.yml](../electron-builder.yml). (Currently `jainath/devharbor` — change it there if needed.)
6. **GitHub Actions enabled** for that repo.
7. **GitHub Secrets**, set under *Settings → Secrets and variables → Actions*:

   | Secret | Value |
   |---|---|
   | `MAC_CERTIFICATE_P12` | `base64 -i Cert.p12 \| pbcopy`, then paste |
   | `MAC_CERTIFICATE_PASSWORD` | the password you set on export |
   | `APPLE_ID` | your Apple developer email |
   | `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password from step 3 |
   | `APPLE_TEAM_ID` | the 10-char Team ID from step 4 |

`GITHUB_TOKEN` is provided automatically by Actions; nothing to set.

### Icon

Drop a `build/icon.icns` (1024×1024 source preferred). Without one, electron-builder falls back to its default and the DMG looks unprofessional. Quick generation from a PNG:

```bash
mkdir build/icon.iconset
sips -z 16 16     icon.png --out build/icon.iconset/icon_16x16.png
sips -z 32 32     icon.png --out build/icon.iconset/icon_16x16@2x.png
sips -z 32 32     icon.png --out build/icon.iconset/icon_32x32.png
sips -z 64 64     icon.png --out build/icon.iconset/icon_32x32@2x.png
sips -z 128 128   icon.png --out build/icon.iconset/icon_128x128.png
sips -z 256 256   icon.png --out build/icon.iconset/icon_128x128@2x.png
sips -z 256 256   icon.png --out build/icon.iconset/icon_256x256.png
sips -z 512 512   icon.png --out build/icon.iconset/icon_256x256@2x.png
sips -z 512 512   icon.png --out build/icon.iconset/icon_512x512.png
cp icon.png       build/icon.iconset/icon_512x512@2x.png
iconutil -c icns  build/icon.iconset -o build/icon.icns
rm -rf            build/icon.iconset
```

## Local unsigned build (for smoke testing)

```bash
pnpm install
pnpm pack:mac
```

Outputs `dist/devharbor-<version>-arm64.dmg` (+ x64). The afterSign hook detects no credentials and skips notarization. Gatekeeper will warn on first run; right-click → Open to bypass.

## Local signed + notarized build

Set the env vars locally and re-run `pnpm pack:mac`:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="ABCDE12345"
export CSC_LINK="/abs/path/to/cert.p12"
export CSC_KEY_PASSWORD="your-export-password"

pnpm pack:mac
```

Notarization stapling takes 2–15 minutes; you'll see the `[notarize] done.` line when it's complete. Verify:

```bash
spctl --assess --verbose dist/mac/App\ Manager.app
# → /path: accepted; source=Notarized Developer ID
```

## Cutting a release via tag (the normal path)

```bash
# Bump version in package.json, commit:
git add package.json && git commit -m "release: v0.1.1"

# Tag and push:
git tag v0.1.1
git push origin main --tags
```

GitHub Actions picks up the tag, runs `.github/workflows/release.yml`, builds + signs + notarizes both arches, and publishes to GitHub Releases. electron-updater picks up the new release on the next launch of any v0.1.0 install and prompts via the `UpdateBanner`.

## How auto-update works at runtime

1. App boots. `Updater.start()` runs if `auto_update` setting is true.
2. `autoUpdater.checkForUpdates()` fetches `https://github.com/<owner>/<repo>/releases/latest/download/latest-mac.yml`.
3. If a newer version exists, `update-available` fires → UpdateBanner shows "Downloading…".
4. Download completes → `update-downloaded` fires → UpdateBanner shows "Update vX.Y.Z ready · Quit & install".
5. User clicks → `update:install` IPC → `autoUpdater.quitAndInstall(true, true)` → app restarts on the new version.

The yaml file (`latest-mac.yml`) and the artifacts (`.dmg`, `.zip`, the `.blockmap` for delta updates) are all published in the same Release.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "App is damaged and can't be opened" | Unsigned/unnotarized download | Either right-click → Open, or finish notarization |
| Notarization fails with `Invalid credentials` | App-specific password not set, or set on the wrong Apple ID | Regenerate at appleid.apple.com, update the secret |
| `electron-updater` logs `404 latest-mac.yml` | The Release isn't published (or repo `publish` config is wrong) | Check the release exists in GitHub and the owner/repo in `electron-builder.yml` |
| Auto-update silently does nothing in dev | Expected — `Skip checkForUpdates because application is not packed` | Test updates against a packaged DMG, not `pnpm dev` |
| `NODE_MODULE_VERSION` mismatch on launch | Native deps rebuilt against wrong ABI | `pnpm rebuild` runs `electron-rebuild` for better-sqlite3 + node-pty |
| `ModuleNotFoundError: No module named 'distutils'` during pack | Python 3.12 removed `distutils` from stdlib; bundled node-gyp 9.x still imports it | `python3 -m pip install --user --break-system-packages setuptools` (or use a venv with setuptools installed) |
| `cannot find valid "Developer ID Application" identity` | No signing certificate in the Keychain (local unsigned build) | Expected for local dev; ship with cert in CI per the secrets table above |
| x64 arch missing from DMG | Default config builds arm64 only | CI workflow can add `--x64` if both arches are needed; expect node-gyp issues to resurface for x64 on Apple Silicon |

## Phase 5 acceptance (from [05-roadmap.md](05-roadmap.md))

- [ ] Download DMG → drag to Applications → first launch passes Gatekeeper with no warnings
- [ ] App auto-updates from v0.1.0 → v0.1.1 with no user intervention beyond a quit & relaunch

Both checked when the first signed + notarized release lands in the GitHub feed and a v0.1.0 install can pick it up.
