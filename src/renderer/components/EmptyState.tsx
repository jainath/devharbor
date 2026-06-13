import { Boxes, Play, Workflow, Layers, ScrollText } from 'lucide-react';

/**
 * First-run / empty state. This is the natural place to teach what DevHarbor does - it's
 * seen once, by a brand-new user - so it carries a short value prop + feature highlights,
 * keeping the recurring Add-app flow itself lean.
 */
export function EmptyState({
  onAddApp,
  onImport
}: {
  onAddApp: () => void;
  onImport?: () => void;
}): JSX.Element {
  return (
    <main className="flex flex-1 flex-col overflow-y-auto">
      <div className="titlebar-drag h-10 shrink-0" />
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="w-full max-w-xl text-center">
          <Boxes className="mx-auto h-11 w-11 text-accent" />
          <h2 className="mt-4 text-lg font-semibold text-fg">Welcome to DevHarbor</h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-fg-subtle">
            A harbor for your local dev servers. Run and monitor your Node.js projects from one
            window. Everything stays local: no accounts, no cloud, no telemetry.
          </p>

          <div className="mx-auto mt-6 grid max-w-lg grid-cols-1 gap-3 text-left sm:grid-cols-2">
            <Feature
              icon={<Play className="h-4 w-4" />}
              title="Run & monitor"
              desc="Start, stop, and restart your dev servers, with live CPU, memory, and ports."
            />
            <Feature
              icon={<Workflow className="h-4 w-4" />}
              title="Multi-task apps"
              desc="Apps with several services start in dependency order and wait for readiness."
            />
            <Feature
              icon={<Layers className="h-4 w-4" />}
              title="Per-project Node & env"
              desc="Auto-switch Node versions and layer environment variables: global → app → task."
            />
            <Feature
              icon={<ScrollText className="h-4 w-4" />}
              title="Live logs &amp; ports"
              desc="Searchable xterm logs and auto-detected ports with clickable localhost links."
            />
          </div>

          <div className="mt-7 flex items-center justify-center gap-2">
            <button
              onClick={onAddApp}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:bg-accent/90"
            >
              Add your first app
            </button>
            {onImport && (
              <button
                onClick={onImport}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-fg hover:bg-surface"
              >
                Import a folder of projects…
              </button>
            )}
          </div>
          <p className="mt-2 text-[11px] text-fg-subtle">
            Point DevHarbor at a Node.js project folder - it detects the package manager, Node
            version, and scripts for you.
          </p>
        </div>
      </div>
    </main>
  );
}

function Feature({
  icon,
  title,
  desc
}: {
  icon: JSX.Element;
  title: string;
  desc: string;
}): JSX.Element {
  return (
    <div className="rounded-md border border-border bg-base/50 p-3">
      <div className="flex items-center gap-2 text-fg">
        <span className="text-accent">{icon}</span>
        <span className="text-sm font-medium">{title}</span>
      </div>
      <p className="mt-1 text-[11px] leading-snug text-fg-subtle">{desc}</p>
    </div>
  );
}
