import { detect } from 'package-manager-detector/detect';
import type { PackageManager } from '@shared/types';

/**
 * Pick a package manager for a directory. Wraps `package-manager-detector` and
 * narrows to the four we support.
 */
export class PMDetector {
  async detect(cwd: string): Promise<PackageManager | null> {
    const result = await detect({ cwd });
    if (!result) return null;
    const name = result.name;
    if (name === 'npm' || name === 'yarn' || name === 'pnpm' || name === 'bun') {
      return name;
    }
    return null;
  }
}
