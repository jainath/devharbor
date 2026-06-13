# 00 - Overview

## Problem

Developers juggling several local Node.js services hit the same friction every day:

- Three terminal tabs open for one project (server, worker, frontend). Lost when the terminal crashes.
- "Which Node version does this repo want again?" → `nvm use`, hope `.nvmrc` is right.
- Editing `.env` in a text editor, restarting by hand, forgetting which port a service is on.
- No single view of "what is currently running on my machine."
- Switching between npm / yarn / pnpm projects - easy to use the wrong one.

## Vision

One desktop app that knows about all your local Node.js projects and gives you a calm, dense, professional interface to run them.

The product the user has in their head: "Postman, but for local dev servers." Not literally Postman - we are not an API client - but the same *feel*: a sidebar of registered things, a main area showing the active one, sensible defaults, keyboard-driven, dev-tool aesthetic.

## Primary user

A working developer on macOS who:

- Maintains 3-20 local Node.js projects
- Uses some combination of npm, yarn, and pnpm
- Has nvm (or fnm, or Volta, or asdf) installed
- Wants tighter feedback loops and less terminal-tab archaeology

## Goals (v1)

1. **Register** local app directories by browsing to them.
2. **Detect** Node version, package manager, and available scripts automatically; allow overrides.
3. **Run** the chosen script with the correct Node version and package manager.
4. **Stop** apps cleanly - entire process tree, no orphans.
5. **Env vars** - global defaults + per-app overrides, layered, with `.env` file integration.
6. **Logs** - live stdout/stderr per app, real terminal rendering, searchable history.
7. **Dashboard** - at-a-glance view of running apps, their ports, CPU/RAM.
8. **Dev-friendly extras** - Cmd-K palette, port detection with clickable links, restart-on-change, `.env` file watching, crash recovery actions.

## Non-goals (explicitly out of scope for v1)

- Windows and Linux. The architecture won't *prevent* them, but we don't validate or polish for them in v1.
- Cloud sync, team sharing, accounts.
- Docker / Docker Compose orchestration. (Spec'd as a Phase 5 stretch.)
- Built-in API client / HTTP testing.
- Container runtimes other than the user's local shell.
- Editing project source files. We launch processes; we don't replace your editor.
- Replacing nvm/fnm/Volta. We *use* the Node versions they install; we don't install Node ourselves.

## Success criteria

- A user can register their first project and click "Start" within 90 seconds of opening the app.
- Stopping an app reliably kills every descendant process. No `lsof` cleanup needed.
- Detection (Node version, package manager, scripts) is right for >95% of typical projects without any user input.
- The app remains responsive (<16ms frame budget in the renderer) while streaming heavy log output.
- Memory footprint of the app itself stays under 250MB with 10 registered apps and 3 running.

## Guiding principles

- **Detect, don't ask.** Read the project. Only prompt when there's genuine ambiguity.
- **The main process owns truth.** Child processes live in the Electron main process. The renderer is a view, not a source of state.
- **Logs are sacred.** Never drop log lines silently. Ring-buffer with a clear retention setting.
- **Keyboard first.** Every action reachable in 2 keystrokes from Cmd-K.
- **Stay calm.** Dense layouts, monospace where it matters, minimal motion, no marketing copy in the UI.
