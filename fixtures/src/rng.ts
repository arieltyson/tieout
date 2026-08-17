/**
 * Deterministic PRNG. Same seed produces the same sequence forever, on any
 * machine, with no dependency on wall-clock time or platform Math.random
 * implementation. mulberry32 — small, fast, and its output is stable across
 * V8 versions because it's pure integer/bitwise arithmetic, unlike
 * Math.random which is explicitly unspecified from run to run.
 */
export interface Rng {
  /** Next float in [0, 1). */
  next(): number;
  /** Next integer in [min, max], inclusive on both ends. */
  int(min: number, max: number): number;
  /** Next float in [min, max). */
  float(min: number, max: number): number;
  /** True with the given probability (default 0.5). */
  bool(probability?: number): boolean;
  /** One element chosen uniformly from a non-empty array. */
  pick<T>(xs: readonly T[]): T;
  /** A new array, Fisher-Yates shuffled; the input is not mutated. */
  shuffle<T>(xs: readonly T[]): T[];
}

export function createRng(seed: number): Rng {
  // mulberry32 state must be a 32-bit unsigned integer.
  let state = seed >>> 0;

  function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new Error(`Invalid int range: [${min}, ${max}]`);
    }
    return min + Math.floor(next() * (max - min + 1));
  }

  function float(min: number, max: number): number {
    return min + next() * (max - min);
  }

  function bool(probability = 0.5): boolean {
    return next() < probability;
  }

  function pick<T>(xs: readonly T[]): T {
    if (xs.length === 0) throw new Error('Cannot pick from an empty array');
    const value = xs[int(0, xs.length - 1)];
    if (value === undefined) throw new Error('Unreachable: pick index out of range');
    return value;
  }

  function shuffle<T>(xs: readonly T[]): T[] {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i);
      const a = out[i];
      const b = out[j];
      if (a === undefined || b === undefined) throw new Error('Unreachable: shuffle index out of range');
      out[i] = b;
      out[j] = a;
    }
    return out;
  }

  return { next, int, float, bool, pick, shuffle };
}
