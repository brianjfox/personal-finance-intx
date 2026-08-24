// Deterministic Monte Carlo (deck slide 7: "Deterministic maths in
// code, narrated by a model").
//
// Determinism is the contract: the same request (including `seed`)
// reproduces the same figures bit-for-bit, so the Auditor can re-run a
// projection the Strategist quoted and get the identical table. The
// engine uses IEEE floats INTERNALLY -- a geometric-Brownian-motion
// simulation over bigint fixed point would be absurd -- which is safe
// because float arithmetic is itself deterministic for a fixed sequence
// of operations; only the OUTPUTS become ledger-grade decimal strings,
// rounded to cents. No wall clock, no Math.random: the caller supplies
// `now` and the seed.

import { decimal, type ProjectionRequest, type ProjectionResult, type ProjectionYear } from "@fin/contracts";

/** mulberry32: tiny, well-distributed, deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the seed string -> 32-bit PRNG seed. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Box-Muller standard normal from two uniforms. */
function normal(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface MonteCarloInputs {
  startValue: string;
  years: number;
  paths: number;
  mu: string;
  sigma: string;
  annualFlow: string;
  seed: string;
  asOf: string;
  evidence: string[];
}

export const PROJECTION_DEFAULTS = { paths: 1000, mu: "0.05", sigma: "0.15", annualFlow: "0", seed: "fin" } as const;

export function resolveProjectionInputs(
  req: ProjectionRequest,
  fallback: { startValue: string; evidence: string[] },
  asOf: string,
): MonteCarloInputs {
  return {
    startValue: req.start_value ?? fallback.startValue,
    years: req.years,
    paths: req.paths ?? PROJECTION_DEFAULTS.paths,
    mu: req.mu ?? PROJECTION_DEFAULTS.mu,
    sigma: req.sigma ?? PROJECTION_DEFAULTS.sigma,
    annualFlow: req.annual_flow ?? PROJECTION_DEFAULTS.annualFlow,
    seed: req.seed ?? PROJECTION_DEFAULTS.seed,
    asOf,
    evidence: req.start_value != null ? [] : fallback.evidence,
  };
}

/**
 * Annual-step GBM: v' = v * exp((mu - sigma^2/2) + sigma * z) + flow,
 * floored at zero (ruin absorbs). Percentiles are per-year across paths.
 */
export function monteCarlo(inputs: MonteCarloInputs): ProjectionResult {
  const start = Number(inputs.startValue);
  const mu = Number(inputs.mu);
  const sigma = Number(inputs.sigma);
  const flow = Number(inputs.annualFlow);
  const drift = mu - (sigma * sigma) / 2;

  const values: number[][] = Array.from({ length: inputs.years }, () => new Array<number>(inputs.paths));
  let ruined = 0;
  for (let p = 0; p < inputs.paths; p += 1) {
    // Per-path stream seeded by (seed, path index): extending the horizon
    // or adding paths never perturbs the figures of earlier years/paths.
    const rng = mulberry32(hashSeed(`${inputs.seed}:${String(p)}`));
    let v = start;
    let everRuined = false;
    for (let y = 0; y < inputs.years; y += 1) {
      if (v > 0) {
        v = v * Math.exp(drift + sigma * normal(rng)) + flow;
      } else {
        // A ruined path stays ruined, but still consumes its normal so
        // per-path draws stay aligned regardless of when ruin hit.
        normal(rng);
      }
      if (v <= 0) {
        v = 0;
        everRuined = true;
      }
      (values[y] as number[])[p] = v;
    }
    if (everRuined) ruined += 1;
  }

  const pct = (sorted: number[], q: number): number => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[idx] as number;
  };
  const byYear: ProjectionYear[] = values.map((row, i) => {
    const sorted = [...row].sort((a, b) => a - b);
    return {
      year: i + 1,
      p10: cents(pct(sorted, 0.1)),
      p50: cents(pct(sorted, 0.5)),
      p90: cents(pct(sorted, 0.9)),
    };
  });

  return {
    as_of: inputs.asOf,
    start_value: decimal.round(inputs.startValue, 2),
    years: inputs.years,
    paths: inputs.paths,
    mu: inputs.mu,
    sigma: inputs.sigma,
    annual_flow: inputs.annualFlow,
    seed: inputs.seed,
    by_year: byYear,
    ruin_probability: cents4(ruined / inputs.paths),
    evidence: inputs.evidence,
  };
}

function cents(v: number): string {
  return decimal.round(v.toFixed(4), 2);
}
function cents4(v: number): string {
  return decimal.round(v.toFixed(6), 4);
}
