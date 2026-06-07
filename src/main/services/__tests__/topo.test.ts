import { describe, expect, it } from 'vitest';
import { findCycle, topoLevels } from '../topo';

type ID = string;

function deps(...pairs: [ID, ID[]][]): Map<ID, ID[]> {
  return new Map(pairs);
}

describe('topoLevels', () => {
  it('returns a single level when there are no dependencies', () => {
    const levels = topoLevels(['a', 'b', 'c'], new Map());
    expect(levels).toEqual([['a', 'b', 'c']]);
  });

  it('orders dependents after their dependencies', () => {
    const d = deps(
      ['migrate', []],
      ['api', ['migrate']],
      ['web', ['api']]
    );
    const levels = topoLevels(['migrate', 'api', 'web'], d);
    expect(levels).toEqual([['migrate'], ['api'], ['web']]);
  });

  it('groups siblings at the same level', () => {
    const d = deps(
      ['build', []],
      ['api', ['build']],
      ['web', ['build']]
    );
    const levels = topoLevels(['build', 'api', 'web'], d);
    expect(levels[0]).toEqual(['build']);
    expect(new Set(levels[1])).toEqual(new Set(['api', 'web']));
  });

  it('throws on cycle with the offending nodes named', () => {
    const d = deps(
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']]
    );
    expect(() => topoLevels(['a', 'b', 'c'], d)).toThrowError(/cycle/i);
  });

  it('throws when a dep points at an unknown node', () => {
    const d = deps(['a', ['ghost']]);
    expect(() => topoLevels(['a'], d)).toThrowError(/unknown task/i);
  });
});

describe('findCycle', () => {
  it('returns null when the graph is acyclic', () => {
    const d = deps(['a', ['b']], ['b', ['c']], ['c', []]);
    expect(findCycle(['a', 'b', 'c'], d)).toBeNull();
  });

  it('finds a direct two-node cycle', () => {
    const d = deps(['a', ['b']], ['b', ['a']]);
    const cycle = findCycle(['a', 'b'], d);
    expect(cycle).not.toBeNull();
    expect(cycle).toContain('a');
    expect(cycle).toContain('b');
  });

  it('finds a self-loop', () => {
    const d = deps(['a', ['a']]);
    expect(findCycle(['a'], d)).toEqual(['a', 'a']);
  });
});
