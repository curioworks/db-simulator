/** Deterministic PRNG. All engine randomness must flow through one of these. */
export type PRNG = () => number;

/**
 * mulberry32 — small, fast, good-enough 32-bit seeded generator.
 * Returns numbers in [0, 1).
 */
export function mulberry32(seed: number): PRNG {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
