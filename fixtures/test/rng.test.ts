import { describe, expect, test } from 'vitest';
import { createRng } from '../src/rng.js';

describe('createRng', () => {
  test('the same seed produces the identical sequence', () => {
    const a = createRng(20260601);
    const b = createRng(20260601);
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  test('different seeds produce different sequences', () => {
    const a = createRng(1);
    const b = createRng(2);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  test('next() stays within [0, 1)', () => {
    const rng = createRng(42);
    for (let i = 0; i < 1000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test('int() is inclusive on both ends and stays in range', () => {
    const rng = createRng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const v = rng.int(1, 3);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(3);
      seen.add(v);
    }
    expect(seen).toEqual(new Set([1, 2, 3]));
  });

  test('pick() only returns elements from the input', () => {
    const rng = createRng(9);
    const xs = ['a', 'b', 'c'];
    for (let i = 0; i < 100; i++) {
      expect(xs).toContain(rng.pick(xs));
    }
  });

  test('pick() throws on an empty array', () => {
    const rng = createRng(9);
    expect(() => rng.pick([])).toThrow(/empty/i);
  });

  test('shuffle() is a permutation and does not mutate the input', () => {
    const rng = createRng(11);
    const xs = [1, 2, 3, 4, 5];
    const original = [...xs];
    const shuffled = rng.shuffle(xs);
    expect(xs).toEqual(original);
    expect(shuffled).toHaveLength(xs.length);
    expect([...shuffled].sort()).toEqual([...xs].sort());
  });

  test('shuffle() with the same seed produces the same permutation', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = createRng(123).shuffle(xs);
    const b = createRng(123).shuffle(xs);
    expect(a).toEqual(b);
  });
});
