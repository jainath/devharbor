// Type declarations for Vite's import.meta extensions in the main bundle.
// (We can't use `vite/client` here because it pulls in DOM types.)

interface ImportMeta {
  readonly glob: <T = unknown>(
    pattern: string | string[],
    options?: {
      query?: string;
      import?: string;
      eager?: boolean;
    }
  ) => Record<string, T>;
}
