# Contributing to DevHarbor

Thanks for your interest in DevHarbor! This is a macOS-first desktop app for managing
local Node.js dev servers. Contributions of all kinds are welcome — bug reports, fixes,
features, docs, and design feedback.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## TL;DR

```bash
# Requires Node 22+ and pnpm
nvm use            # or: nvm install 22 && nvm use 22   (an .nvmrc is committed)
pnpm install       # installs deps + rebuilds native modules for Electron's ABI
pnpm dev           # launch the app with hot-reload

pnpm typecheck     # tsc on both main + renderer
pnpm test          # vitest
```

## Prerequisites

- **macOS** (Apple Silicon or Intel). The app is macOS-only today — it relies on
  `lsof`/`pgrep`, `open -a`, and Unix Node-manager paths. Windows/Linux are not supported
  yet (see the roadmap).
- **Node 22+** (an `.nvmrc` pins the version) and **pnpm** (`npm i -g pnpm`).
- **Xcode Command Line Tools** (`xcode-select --install`) — needed to rebuild the native
  modules (`better-sqlite3`, `node-pty`).

If `pnpm install` fails rebuilding native modules, see
[`specs/06-release.md`](specs/06-release.md) for the Python/setuptools fix.

## Project layout

```
src/main/        Electron main process (services, IPC, DB, menu)
src/preload/     contextBridge API surface
src/renderer/    React UI (components, store, hooks)
src/shared/      shared types + the typed IPC contract (ipc.ts)
specs/           the source of truth — read before non-trivial work
```

## The specs are the source of truth

DevHarbor is **spec-driven**. Before non-trivial work, read the relevant file in
[`specs/`](specs/), and update it in the same PR when you change behaviour. See
[`specs/WORKFLOW.md`](specs/WORKFLOW.md) for the rules of the road, and
[`specs/PROGRESS.md`](specs/PROGRESS.md) for the current build status.

Quick map:
- [`specs/01-architecture.md`](specs/01-architecture.md) — process model, IPC, stack
- [`specs/02-data-model.md`](specs/02-data-model.md) — SQLite schema + core types
- [`specs/03-features.md`](specs/03-features.md) — every feature with acceptance criteria
- [`specs/04-ui.md`](specs/04-ui.md) — screens, layout, interactions

## Development workflow

1. **Fork** the repo and create a branch off `main`:
   `git checkout -b fix/short-description`
2. Make your change. Keep it focused — one logical change per PR.
3. **Match the surrounding code.** Follow existing naming, comment density, and idioms.
4. Run the checks locally:
   ```bash
   pnpm typecheck && pnpm test
   ```
5. If you changed UI or behaviour, **verify in the running app** (`pnpm dev`) and update
   the relevant spec + `specs/PROGRESS.md`.
6. Open a PR using the template. Link any related issue.

### Architecture rules worth knowing

- **All renderer ↔ main communication goes through the typed contract** in
  [`src/shared/ipc.ts`](src/shared/ipc.ts). Add a channel there first; never use raw
  `ipcRenderer`.
- **Security boundary stays intact:** `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`. Don't loosen these.
- **Native modules** (`better-sqlite3`, `node-pty`) must be rebuilt for Electron's ABI
  (`pnpm rebuild`), not Node's.
- **Zustand selectors must return stable references** — `?? []` / `?? {}` inside a
  selector causes infinite re-render loops. Use module-level constants.

## Tests

- Unit tests live in `src/main/services/__tests__/` and run with `vitest`.
- Pure functions (topo sort, env layering, log buffer, port-regex) are covered; please add
  tests for new pure logic.
- `pnpm test` must pass before a PR is merged.

## Commit & PR style

- Clear, imperative commit subjects ("Fix port detection for nested process trees").
- Reference issues with `Fixes #123` where applicable.
- PRs should pass typecheck + tests and include spec updates when behaviour changes.

## Reporting bugs / requesting features

Use the [issue templates](.github/ISSUE_TEMPLATE/). For security issues, **do not open a
public issue** — see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the project's
[GNU AGPL-3.0](LICENSE) license (inbound = outbound). You also confirm you have the right to
submit the work under that license.

Note the [trademark policy](TRADEMARK.md): the code is AGPL, but the **DevHarbor name and logo
are not** — forks must ship under a different name.
