import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DetectionResult } from '@shared/types';
import { PMDetector } from './PMDetector';
import { NodeResolver } from './NodeResolver';

const SCRIPT_PRIORITY = ['dev', 'start', 'serve', 'develop'];

export class DetectionService {
  constructor(
    private readonly pms = new PMDetector(),
    private readonly node = new NodeResolver()
  ) {}

  async detect(projectPath: string): Promise<DetectionResult> {
    const packageManager = await this.pms.detect(projectPath);
    const nodeVersionFromProject =
      this.node.readProjectNodeVersion(projectPath) ?? this.node.readEnginesNode(projectPath);

    const scripts = this.readScripts(projectPath);
    const envFiles = this.findEnvFiles(projectPath);

    const suggestedDefaultScript =
      SCRIPT_PRIORITY.find((s) => Object.prototype.hasOwnProperty.call(scripts, s)) ??
      Object.keys(scripts)[0] ??
      null;

    return {
      packageManager,
      nodeVersionFromProject,
      scripts,
      hasEnvFile: envFiles.length > 0,
      envFiles,
      suggestedDefaultScript
    };
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
