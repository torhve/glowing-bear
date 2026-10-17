# Release Process — Glowing Bear

Cuts a new release with static web build + Tauri desktop packages (.dmg, .deb, .msi).

## Prerequisites

- `main` branch is current and CI passes
- All version numbers synced (see below)
- Clean working tree (`git status` shows nothing)

---

## Step 1: Update versions locally

Three files must have matching version numbers. For a new release (e.g., `0.21.0`):

| File | Field | Command |
|------|-------|---------|
| `package.json` | `"version"` | Manual edit or `npm version <ver>` |
| `src-tauri/tauri.conf.json` | `"version"` | Manual edit |
| `src-tauri/Cargo.toml` | `version = "<ver>"` | Manual edit (has `#sync` comment) |

```bash
# npm version updates package.json automatically
npm version 0.21.0 --no-git-tag-version

# Then manually edit these two files to match:
#   src-tauri/tauri.conf.json   → "version": "0.21.0"
#   src-tauri/Cargo.toml        → version = "0.21.0"
```

> **Note:** `npm version` does NOT update the Tauri config files. You must edit them manually.

---

## Step 2: Verify everything builds locally

Run all checks before committing. The Tauri build is required — it catches platform-specific issues CI might miss locally.

```bash
# Type check
npm run check

# Lint
npm run lint

# Unit tests
npm test

# E2E tests (required)
npm run test:e2e                # must be a CLEAN run — see the flake note below

# Production build (static web)
npm run build

# Tauri desktop build (required — catches platform-specific issues)
npm run tauri build
```

If any step fails, fix before proceeding.

E2E flakes are load-sensitive, not free: `ChatView-scroll` and `Nicklist-mobileSwipe`
have failed under a loaded machine before, and full UI runs have intermittently failed in
App-layout and KeyboardShortcuts. A release requires a full clean run of both passes —
rerun the whole suite before believing an isolated failure, and never release on a run
that had a failure even if the failing spec passes on its own.

`npm run tauri build` can fail at its last step — `failed to run bundle_dmg.sh` — after
the Rust build and `Glowing Bear.app` both succeeded. That is the DMG bundler tripping
over volumes an earlier build left mounted: `ls /Volumes/ | grep '^dmg\.'` showed four
of them here, and ejecting each with `hdiutil detach /Volumes/dmg.XXXX -force` made the
same command produce both bundles. Eject them before reading it as a platform defect.

---

## Step 3: Commit and push

```bash
git add -A
git commit -m "release: v0.21.0"
git push origin main
```

Wait for the **CI** workflow to pass on GitHub Actions. Check the Actions tab for green checks.

---

## Step 4: Create git tag

```bash
git tag v0.21.0
git push origin v0.21.0
```

> **Important:** Pushing a tag alone does NOT trigger builds. You must publish a release in the GitHub UI (next step).

---

## Step 5: Publish release on GitHub

1. Go to **Releases** → **Create a new release**
2. Select the tag you just pushed (`v0.21.0`)
3. Click **Publish release**

Publishing the release automatically triggers the **Build & Release** workflow. Write release notes directly in the GitHub UI — no separate changelog file is maintained.

A release note for this codebase has to name the transport facts, because they change
what the user has to run on the WeeChat side:

- which relay transports the release speaks (`api` on WeeChat 4.10.1+, legacy `weechat`
  on older WeeChat), and that the app probes the address and picks one transport per connection
- the minimum WeeChat version for the API transport, and that the legacy transport still
  works but is no longer the default path
- anything the release refuses rather than degrades: a TOTP-protected relay is rejected
  with an error, not half-supported
- the `/grep` requirement for content search, and that a missing script is reported as
  such only when the script listing from the relay proves it is missing

---

## Step 6: Monitor builds

The **Build & Release** workflow compiles simultaneously on three platforms:

| Platform | Artifact | Estimated time |
|----------|----------|----------------|
| macOS (Apple Silicon) | `.dmg` | ~15–25 min |
| Ubuntu 24.04 | `.deb` | ~10–15 min |
| Windows | `.msi` | ~15–20 min |

Once all jobs pass, artifacts attach automatically to the GitHub release page.

---

## Quick reference checklist

- [ ] Versions synced in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`
- [ ] `npm run check` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] `npm run test:e2e` passes
- [ ] `npm run build` succeeds
- [ ] `npm run tauri build` succeeds
- [ ] Commit pushed to `main`
- [ ] CI workflow green on GitHub
- [ ] Git tag created and pushed (`git tag v0.X.Y && git push origin v0.X.Y`)
- [ ] Release published on GitHub (triggers Build & Release workflow)
- [ ] All platform builds complete successfully
- [ ] Artifacts verified on release page
