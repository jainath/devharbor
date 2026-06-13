import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * Top-level renderer error boundary. Without it, any uncaught render/effect exception makes
 * React 18 unmount the whole root, leaving a permanently blank window whose only recovery is
 * a Cmd-R the user has to know about (IMPROVEMENT-PLAN 13.2). Running apps are unaffected - 
 * they live in the main process and survive a renderer reload.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] uncaught error:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full w-full items-center justify-center bg-base p-8">
          <div className="max-w-md text-center">
            <h2 className="text-lg font-semibold text-fg">DevHarbor hit an error</h2>
            <p className="mt-2 text-sm text-fg-subtle">
              The interface crashed, but your running apps are unaffected - they run in the
              background process and keep going. Reloading rebuilds the window.
            </p>
            <pre className="mt-3 max-h-40 overflow-auto rounded-md border border-border bg-surface p-2 text-left text-[11px] text-danger-fg">
              {this.state.error.message}
            </pre>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:bg-accent/90"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
