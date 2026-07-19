import { mulberry32 } from './prng.ts';
import type { SkewConfig, SkewModel } from './types.ts';

/** Terms of the harmonic sum evaluated exactly before switching to the tail formula. */
const EXACT_TERMS = 10_000;

/**
 * Generalized harmonic number H(n, s) = Σ i^−s, the Zipf normalizer.
 *
 * Summing all n terms is O(n), and n reaches 10^8 here — that alone would
 * cost more than the entire tick loop and break the milliseconds budget. So
 * the first 10,000 terms are summed exactly and the remainder closed-form via
 * Euler–Maclaurin (integral + endpoint + first-derivative correction), which
 * is accurate to ~1e-12 at that crossover and O(1).
 */
export function harmonic(n: number, s: number): number {
  if (s === 0) return n;
  const m = Math.min(n, EXACT_TERMS);
  let sum = 0;
  for (let i = 1; i <= m; i++) sum += i ** -s;
  if (n <= EXACT_TERMS) return sum;
  const integral = s === 1 ? Math.log(n / m) : (n ** (1 - s) - m ** (1 - s)) / (1 - s);
  const endpoints = (n ** -s - m ** -s) / 2;
  const derivative = (s * (m ** (-s - 1) - n ** (-s - 1))) / 12;
  return sum + integral + endpoints + derivative;
}

/**
 * Build the M6 skew model: Zipf write shares for the top-K partitions plus an
 * aggregate tail, and the partition → token → replica-set mapping.
 *
 * Token ring: node j owns the range [j/N, (j+1)/N). Each hot partition draws
 * one uniform token, and the owning node plus the next RF−1 clockwise hold
 * its replicas (SimpleStrategy placement). Two hot partitions can land on the
 * same node — that concentration is the whole point. The tail bucket stands
 * for everything past the top K: individually cold partitions whose many
 * random placements average out, so its bytes spread evenly across nodes.
 *
 * `nodeShare[j]` is node j's fraction of *cluster-wide* disk bytes (which
 * already count every replica): a partition with write share w puts w × 1/RF
 * of the cluster total on each of its RF nodes.
 */
export function buildSkewModel(config: SkewConfig, seed: number): SkewModel {
  const { partitionCount, zipfExponent, topK, nodes, replicationFactor } = config;

  if (!Number.isInteger(partitionCount) || partitionCount < 1) {
    throw new RangeError(`partitionCount must be a positive integer, got ${partitionCount}`);
  }
  if (zipfExponent < 0) throw new RangeError(`zipfExponent must be ≥ 0, got ${zipfExponent}`);
  if (!Number.isInteger(topK) || topK < 1) {
    throw new RangeError(`topK must be a positive integer, got ${topK}`);
  }
  if (!Number.isInteger(nodes) || nodes < 1) {
    throw new RangeError(`nodes must be a positive integer, got ${nodes}`);
  }
  if (!Number.isInteger(replicationFactor) || replicationFactor < 1) {
    throw new RangeError(`replicationFactor must be a positive integer, got ${replicationFactor}`);
  }
  if (replicationFactor > nodes) {
    throw new RangeError(
      `replicationFactor (${replicationFactor}) cannot exceed nodes (${nodes})`,
    );
  }

  // Zipf: partition ranked i gets weight i^−s / H(partitionCount, s).
  const h = harmonic(partitionCount, zipfExponent);
  const k = Math.min(topK, partitionCount);
  const hotWeights = Array.from({ length: k }, (_, i) => (i + 1) ** -zipfExponent / h);
  const tailWeight = Math.max(0, 1 - hotWeights.reduce((a, w) => a + w, 0));

  // A separate PRNG stream for placement: the main engine rng feeds the
  // compaction strategies, and drawing tokens from it would shift that
  // sequence and change every pre-M6 golden.
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const hotReplicas = hotWeights.map(() => {
    const primary = Math.floor(rng() * nodes);
    return Array.from({ length: replicationFactor }, (_, r) => (primary + r) % nodes);
  });

  const nodeShare = new Array<number>(nodes).fill((tailWeight * replicationFactor) / nodes);
  hotReplicas.forEach((replicas, i) => {
    for (const node of replicas) nodeShare[node] += hotWeights[i];
  });
  return { hotWeights, tailWeight, hotReplicas, nodeShare: nodeShare.map((s) => s / replicationFactor) };
}
