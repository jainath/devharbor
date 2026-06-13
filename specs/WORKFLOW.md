# WORKFLOW

How we work on this project. Read this once; expect to reread it when habits slip.

## Rule 1 - Specs are the source of truth

The `specs/` folder owns the design and the build status. Code does not.

- **Before** any non-trivial change: re-read the relevant spec section.
- **Before** writing code on any design shift: update the spec first, get the user's sign-off if it's a meaningful decision, *then* implement.
- **After** a phase, feature, or significant chunk: update [`PROGRESS.md`](PROGRESS.md) - flip rows from 📐/🚧 → ✅, add new gaps to the known-limitations list.

`PROGRESS.md` is the canonical "where are we right now." Don't let it drift.

## Rule 2 - Step back after every code or UI change

Before declaring a chunk done or moving on, run a short review. The goal: surface follow-ups while context is fresh, so the user can decide what matters before it's buried.

Ask:

- Does what I shipped meet the spec's acceptance criteria? Anything implicitly traded off?
- UX nits I skipped? (autofocus, error dismissal, keyboard shortcuts, busy states, empty states)
- Spec "edge cases" / "acceptance" lines I didn't cover?
- New tech debt or brittle patterns introduced?
- Cross-cutting concerns: types, performance, accessibility, error / crash / disconnect paths?
- Did I update `PROGRESS.md`?

Then surface the **top 3-5 follow-up items** in chat, each with a one-line description and a placement: *fix now* / *Phase N* / *drop* / *carry-list*. Don't auto-implement - the user decides.

Keep the in-chat review tight (under 15 lines). Heavy itemising goes into PROGRESS.md's known-limitations / followups section.

This rule applies to **code/UI changes**. Spec edits ARE the bigger-picture review and don't need a second step-back.

## Rule 3 - Don't assume; ask when in doubt

If the spec is silent on something the user just asked for, write the spec entry, surface the design call with one targeted question (or a recommendation), and wait. Avoid silent design decisions buried in implementation.

## Rule 4 - Migration discipline

- Schema changes go through numbered `.sql` migrations in `src/main/db/migrations/`.
- Data backfills run in TypeScript (`src/main/db/backfill.ts`) so they can use ULIDs, JSON shapes, etc.
- Migrations are forward-only and idempotent where possible.
- Update [`specs/02-data-model.md`](02-data-model.md)'s Migrations table when adding a new file.

## Rule 5 - Native deps need attention

`better-sqlite3` and `@homebridge/node-pty-prebuilt-multiarch` ship Node-ABI prebuilds. They MUST be rebuilt for Electron's ABI via `electron-rebuild`. The project's `postinstall` runs that automatically. If a fresh install fails at runtime with "NODE_MODULE_VERSION mismatch," run `pnpm rebuild`.

## Rule 6 - Renderer state pitfalls

Zustand selectors must return referentially stable values. Never use `?? []` or `?? {}` inside `useStore((s) => ...)` - each call creates a new reference and `useSyncExternalStore` will treat it as a change, causing an infinite render loop. Use a module-level stable empty constant instead.
