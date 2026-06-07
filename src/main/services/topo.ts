/**
 * Topological sort over a `Map<NodeId, Set<NodeId>>` (deps -> dependents not needed,
 * we go from a node to *its* dependencies).
 *
 * Returns an array of "levels": all nodes in level N can run in parallel; they all depend
 * (transitively) only on nodes in level 0..N-1.
 *
 * Throws on cycle, naming the nodes in the cycle for the user.
 */
export function topoLevels<T extends string>(
  nodes: readonly T[],
  dependsOn: Map<T, readonly T[]>
): T[][] {
  const inDegree = new Map<T, number>();
  for (const n of nodes) inDegree.set(n, 0);

  for (const n of nodes) {
    for (const d of dependsOn.get(n) ?? []) {
      if (!inDegree.has(d)) {
        throw new Error(`Task "${n}" depends on unknown task "${d}".`);
      }
    }
  }

  // Build a reverse adjacency for Kahn's algorithm: from a dep to its dependents.
  const dependents = new Map<T, T[]>();
  for (const n of nodes) dependents.set(n, []);
  for (const n of nodes) {
    for (const d of dependsOn.get(n) ?? []) {
      dependents.get(d)!.push(n);
      inDegree.set(n, (inDegree.get(n) ?? 0) + 1);
    }
  }

  const levels: T[][] = [];
  const remaining = new Set(nodes);

  while (remaining.size > 0) {
    const level: T[] = [];
    for (const n of remaining) {
      if (inDegree.get(n) === 0) level.push(n);
    }
    if (level.length === 0) {
      throw new Error(
        `Dependency cycle detected among tasks: ${[...remaining].join(', ')}`
      );
    }
    for (const n of level) {
      remaining.delete(n);
      for (const d of dependents.get(n) ?? []) {
        inDegree.set(d, (inDegree.get(d) ?? 0) - 1);
      }
    }
    levels.push(level);
  }

  return levels;
}

/**
 * Detect cycles without throwing. Returns the cycle path (array of node ids) or null.
 * Used at save-time validation to give the user a clear error.
 */
export function findCycle<T extends string>(
  nodes: readonly T[],
  dependsOn: Map<T, readonly T[]>
): T[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<T, number>();
  for (const n of nodes) color.set(n, WHITE);

  let foundCycle: T[] | null = null;

  function visit(n: T, stack: T[]): boolean {
    color.set(n, GRAY);
    stack.push(n);
    for (const d of dependsOn.get(n) ?? []) {
      const c = color.get(d) ?? WHITE;
      if (c === GRAY) {
        const start = stack.indexOf(d);
        foundCycle = start >= 0 ? [...stack.slice(start), d] : [...stack, d];
        return true;
      }
      if (c === WHITE && visit(d, stack)) return true;
    }
    color.set(n, BLACK);
    stack.pop();
    return false;
  }

  for (const n of nodes) {
    if ((color.get(n) ?? WHITE) === WHITE) {
      if (visit(n, [])) return foundCycle;
    }
  }
  return null;
}
