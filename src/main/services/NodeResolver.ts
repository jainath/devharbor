import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import semver from 'semver';
import type { NodeInstallation, NodeVersionPref } from '@shared/types';

/**
 * Discover Node installations across nvm / fnm / volta / asdf / system,
 * and resolve a project's preferred version to an absolute bin directory.
 *
 * Filesystem-based — does NOT shell out to nvm (which is a shell function).
 */
export class NodeResolver {
  private cache: NodeInstallation[] | null = null;

  list(force = false): NodeInstallation[] {
    if (!force && this.cache) return this.cache;
    const found: NodeInstallation[] = [];

    found.push(...this.scanNvm());
    found.push(...this.scanFnm());
    found.push(...this.scanVolta());
    found.push(...this.scanAsdf());

    const system = this.scanSystem();
    if (system) found.push(system);

    // De-dupe by version+source, preferring earlier sources.
    const seen = new Set<string>();
    const deduped: NodeInstallation[] = [];
    for (const n of found) {
      const k = `${n.source}:${n.version}`;
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(n);
    }
    deduped.sort((a, b) => semver.rcompare(a.version, b.version));
    this.cache = deduped;
    return deduped;
  }

  /**
   * Resolve a project's preferred Node version to an installation.
   * Throws if the preferred version is not installed.
   */
  resolve(pref: NodeVersionPref, projectDir: string): NodeInstallation {
    const installs = this.list();

    if (pref.kind === 'system') {
      const sys = installs.find((i) => i.source === 'system');
      if (!sys) throw new Error('No system Node installation found.');
      return sys;
    }

    if (pref.kind === 'explicit') {
      const match = installs.find((i) => i.version === pref.version);
      if (!match) {
        throw new Error(
          `Node v${pref.version} is not installed. Install it first (e.g. \`nvm install ${pref.version}\`).`
        );
      }
      return match;
    }

    // auto: .nvmrc / .node-version / engines.node
    const projectVersion = this.readProjectNodeVersion(projectDir);
    if (projectVersion) {
      const match = installs.find((i) => i.version === projectVersion);
      if (match) return match;
      // Allow major-only matches: ".nvmrc=20" → highest installed 20.x.
      if (/^\d+$/.test(projectVersion)) {
        const major = projectVersion;
        const cand = installs.find((i) => semver.major(i.version) === Number(major));
        if (cand) return cand;
      }
      throw new Error(
        `Project requires Node v${projectVersion} but it's not installed. Install it (e.g. \`nvm install ${projectVersion}\`) and retry.`
      );
    }

    const enginesRange = this.readEnginesNode(projectDir);
    if (enginesRange) {
      const cand = installs
        .filter((i) => semver.satisfies(i.version, enginesRange, { includePrerelease: false }))
        .sort((a, b) => semver.rcompare(a.version, b.version))[0];
      if (cand) return cand;
      throw new Error(
        `No installed Node version satisfies engines.node "${enginesRange}". Installed: ${installs
          .map((i) => i.version)
          .join(', ') || '(none)'}`
      );
    }

    // No preference at all → highest LTS-ish installed version, else system.
    if (installs.length > 0) return installs[0]!;
    throw new Error('No Node installations found on this machine.');
  }

  readProjectNodeVersion(projectDir: string): string | null {
    const candidates = ['.nvmrc', '.node-version'];
    for (const f of candidates) {
      const p = join(projectDir, f);
      if (existsSync(p)) {
        const raw = readFileSync(p, 'utf8').trim();
        if (!raw) continue;
        // Strip leading 'v' and any trailing whitespace/comments.
        const cleaned = raw.replace(/^v/, '').split(/\s+/)[0];
        if (cleaned) return cleaned;
      }
    }
    return null;
  }

  readEnginesNode(projectDir: string): string | null {
    const pkg = join(projectDir, 'package.json');
    if (!existsSync(pkg)) return null;
    try {
      const data = JSON.parse(readFileSync(pkg, 'utf8'));
      const node = data?.engines?.node;
      return typeof node === 'string' ? node : null;
    } catch {
      return null;
    }
  }

  // --- private scanners --------------------------------------------------

  private scanNvm(): NodeInstallation[] {
    const root = process.env.NVM_DIR || join(homedir(), '.nvm');
    const dir = join(root, 'versions', 'node');
    return this.scanVersionDir(dir, 'nvm', (versionDir) => join(versionDir, 'bin'));
  }

  private scanFnm(): NodeInstallation[] {
    // fnm layout: ~/.local/share/fnm/node-versions/<version>/installation/bin
    // or ~/.fnm/node-versions on macOS for older installs.
    const candidates = [
      join(homedir(), '.local', 'share', 'fnm', 'node-versions'),
      join(homedir(), '.fnm', 'node-versions'),
      join(homedir(), 'Library', 'Application Support', 'fnm', 'node-versions')
    ];
    const out: NodeInstallation[] = [];
    for (const root of candidates) {
      out.push(
        ...this.scanVersionDir(root, 'fnm', (versionDir) => join(versionDir, 'installation', 'bin'))
      );
    }
    return out;
  }

  private scanVolta(): NodeInstallation[] {
    const root = join(homedir(), '.volta', 'tools', 'image', 'node');
    return this.scanVersionDir(root, 'volta', (versionDir) => join(versionDir, 'bin'));
  }

  private scanAsdf(): NodeInstallation[] {
    const root = join(homedir(), '.asdf', 'installs', 'nodejs');
    return this.scanVersionDir(root, 'asdf', (versionDir) => join(versionDir, 'bin'));
  }

  private scanVersionDir(
    root: string,
    source: NodeInstallation['source'],
    binDirFor: (versionDir: string) => string
  ): NodeInstallation[] {
    if (!existsSync(root)) return [];
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return [];
    }
    const out: NodeInstallation[] = [];
    for (const e of entries) {
      const versionDir = join(root, e);
      try {
        if (!statSync(versionDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const cleaned = e.replace(/^v/, '');
      if (!semver.valid(cleaned)) continue;
      const binDir = binDirFor(versionDir);
      if (!existsSync(join(binDir, 'node'))) continue;
      out.push({ source, version: cleaned, binDir });
    }
    return out;
  }

  private scanSystem(): NodeInstallation | null {
    try {
      const nodePath = execSync('command -v node', { encoding: 'utf8', shell: '/bin/sh' }).trim();
      if (!nodePath) return null;
      const version = execSync(`"${nodePath}" --version`, { encoding: 'utf8' })
        .trim()
        .replace(/^v/, '');
      if (!semver.valid(version)) return null;
      const binDir = nodePath.replace(/\/node$/, '');
      // Skip if this matches an installation we already found via a manager.
      // (Caller dedupes by source+version, so a duplicate version with source=system is fine.)
      return { source: 'system', version, binDir };
    } catch {
      return null;
    }
  }
}
