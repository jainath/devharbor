import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DetectionResult, WorkspaceCandidate } from '@shared/types';
import { PMDetector } from './PMDetector';
import { NodeResolver } from './NodeResolver';

const SCRIPT_PRIORITY = ['dev', 'start', 'serve', 'develop'];

function pickSuggested(scriptNames: string[]): string | null {
  return SCRIPT_PRIORITY.find((s) => scriptNames.includes(s)) ?? scriptNames[0] ?? null;
}

export class DetectionService {
  constructor(
    private readonly pms = new PMDetector(),
    private readonly node = new NodeResolver()
  ) {}

  async detect(projectPath: string): Promise<DetectionResult> {
    const packageManager = await this.pms.detect(projectPath);
    const nodeVersionFromProject =
      this.node.readProjectNodeVersion(projectPath) ?? this.node.readEnginesNode(projectPath);

    const hasPackageJson = existsSync(join(projectPath, 'package.json'));
    const scripts = this.readScripts(projectPath);
    const envFiles = this.findEnvFiles(projectPath);

    const suggestedDefaultScript = pickSuggested(Object.keys(scripts));

    return {
      packageManager,
      nodeVersionFromProject,
      scripts,
      hasEnvFile: envFiles.length > 0,
      envFiles,
      suggestedDefaultScript,
      hasPackageJson,
      workspaces: this.detectWorkspaces(projectPath)
    };
  }

  /**
   * Monorepo support: read pnpm-workspace.yaml / package.json "workspaces" globs, expand one
   * level, and return each workspace package that defines runnable scripts. Lets the add flow
   * offer "create a task per workspace package" instead of hand-building each task.
   */
  private detectWorkspaces(root: string): WorkspaceCandidate[] {
    const { include, exclude } = this.workspaceGlobs(root);
    if (include.length === 0) return [];
    const dirs = new Set<string>();
    for (const g of include) {
      for (const d of expandGlob(root, g)) dirs.add(d);
    }
    // pnpm supports negated entries (e.g. `- '!packages/legacy'`) - subtract their expansions
    // so excluded packages aren't offered as workspace-task candidates.
    for (const g of exclude) {
      for (const d of expandGlob(root, g)) dirs.delete(d);
    }
    const out: WorkspaceCandidate[] = [];
    for (const dir of dirs) {
      const pkgPath = join(dir, 'package.json');
      if (!existsSync(pkgPath)) continue;
      try {
        const data = JSON.parse(readFileSync(pkgPath, 'utf8'));
        const scriptNames =
          data?.scripts && typeof data.scripts === 'object'
            ? Object.keys(data.scripts).filter((k) => typeof data.scripts[k] === 'string')
            : [];
        if (scriptNames.length === 0) continue;
        out.push({
          name: typeof data?.name === 'string' ? data.name : relative(root, dir),
          relPath: relative(root, dir),
          scripts: scriptNames,
          suggestedScript: pickSuggested(scriptNames)
        });
      } catch {
        // skip unreadable / malformed package.json
      }
    }
    return out.sort((a, b) => a.relPath.localeCompare(b.relPath)).slice(0, 50);
  }

  private workspaceGlobs(root: string): { include: string[]; exclude: string[] } {
    const include: string[] = [];
    const exclude: string[] = [];
    const push = (raw: string): void => {
      const g = raw.trim();
      if (!g) return;
      if (g.startsWith('!')) exclude.push(g.slice(1));
      else include.push(g);
    };
    // pnpm-workspace.yaml (light line parse - no YAML dep). Handles both the block list
    // (`packages:\n - 'apps/*'`) and the inline flow form (`packages: ['apps/*', 'libs/*']`).
    const pnpmWs = join(root, 'pnpm-workspace.yaml');
    if (existsSync(pnpmWs)) {
      try {
        let inPackages = false;
        for (const raw of readFileSync(pnpmWs, 'utf8').split(/\r?\n/)) {
          const flow = raw.match(/^packages:\s*\[(.*)\]\s*$/);
          if (flow) {
            for (const part of (flow[1] ?? '').split(',')) {
              push(part.replace(/['"]/g, ''));
            }
            continue;
          }
          if (/^packages:\s*$/.test(raw)) {
            inPackages = true;
            continue;
          }
          if (inPackages) {
            const m = raw.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/);
            if (m && m[1]) push(m[1]);
            else if (/^\S/.test(raw)) inPackages = false; // dedented → left the list
          }
        }
      } catch {
        // ignore
      }
    }
    // package.json "workspaces" (npm/yarn) - array or { packages: [...] }.
    const pkgPath = join(root, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const data = JSON.parse(readFileSync(pkgPath, 'utf8'));
        const ws = data?.workspaces;
        const arr = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : [];
        for (const g of arr) if (typeof g === 'string') push(g);
      } catch {
        // ignore
      }
    }
    return { include: [...new Set(include)], exclude: [...new Set(exclude)] };
  }

  private readScripts(projectPath: string): Record<string, string> {
    const pkg = join(projectPath, 'package.json');
    if (!existsSync(pkg)) return {};
    try {
      const data = JSON.parse(readFileSync(pkg, 'utf8'));
      const scripts = data?.scripts;
      if (!scripts || typeof scripts !== 'object') return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(scripts)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }

  private findEnvFiles(projectPath: string): string[] {
    try {
      return readdirSync(projectPath)
        .filter((f) => f === '.env' || f.startsWith('.env.'))
        .sort();
    } catch {
      return [];
    }
  }
}

/**
 * Expand a single workspace glob one level deep. Handles the common monorepo shapes - 
 * `packages/*`, `apps/*`, or an exact relative path - returning absolute directory paths.
 * Deliberately not a full glob engine; deeper/`**` patterns just resolve their static prefix.
 */
function expandGlob(root: string, glob: string): string[] {
  const clean = glob.replace(/\/+$/, '');
  const starIdx = clean.indexOf('*');
  if (starIdx === -1) {
    const abs = join(root, clean);
    return isDir(abs) ? [abs] : [];
  }
  const prefix = clean.slice(0, starIdx).replace(/\/+$/, '');
  const parent = join(root, prefix);
  if (!isDir(parent)) return [];
  try {
    return readdirSync(parent)
      .filter((name) => !name.startsWith('.'))
      .map((name) => join(parent, name))
      .filter(isDir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
