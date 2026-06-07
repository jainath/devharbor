import { FolderPlus } from 'lucide-react';

export function EmptyState({ onAddApp }: { onAddApp: () => void }): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      <div className="titlebar-drag h-10 shrink-0" />
      <div className="flex flex-1 items-center justify-center">
        <div className="max-w-md text-center">
          <FolderPlus className="mx-auto h-10 w-10 text-fg-subtle" />
          <h2 className="mt-3 text-base font-medium text-fg">
            No apps registered yet
          </h2>
          <p className="mt-1 text-sm text-fg-subtle">
            Add a local project folder. We'll detect the Node version, package manager,
            and scripts automatically.
          </p>
          <button
            onClick={onAddApp}
            className="mt-5 rounded-md bg-accent px-3 py-1.5 text-sm text-accent-fg hover:bg-accent/90"
          >
            Add your first app
          </button>
        </div>
      </div>
    </main>
  );
}
