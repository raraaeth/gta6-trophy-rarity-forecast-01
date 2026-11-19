// gta6-trophy-rarity-forecast-01 — forecast every GTA VI PS5 trophy's
// Exophase earn rate (percent of tracked players who hold it) at a case's
// target time. Node 22, standard library only, no network, deterministic.
//
// Model
// -----
// A printed rate is a ratio: earners / players_tracked. The two sides move
// for different reasons, so the program forecasts them separately and
// divides at the end:
//
//   * Exophase refreshes its counts on its own schedule, so consecutive
//     house reads are often identical. The history is first deduped into
//     refresh snapshots: a new snapshot starts when players_tracked or any
//     rate changes. Only snapshots carry information.
//
//   * Players tracked N(t): fit ln N against ln(1 + hours since launch)
//     (power-law growth, weighted toward recent snapshots) and extrapolate
//     to the target. With a single frozen snapshot there is no trend to
//     fit, so a launch-week prior takes over: the tracked pool multiplies
//     over the horizon (on launch night the first refresh alone took it
//     from 638 to 3,868), with the factor growing in the horizon.
//
//   * Earners e_j(t) per trophy: reconstruct e = rate/100 * N at each
//     snapshot, fit ln(1 + e) against ln(1 + hours) the same way, and
//     extrapolate; the forecast is never allowed below the last observed
//     earners (earners cannot fall) nor above the forecast pool. Where a
//     trophy has no usable trend (a single snapshot, or it appears in only
//     one), its earners still drift up over the horizon — the players
//     already tracked keep playing — but slower than the pool grows,
//     which is exactly why rates fall at a refresh. A trophy
//     nobody has earned yet gets a small tier-based prior rate instead of
//     a hard zero, and a saturated trophy (rate >= 99.9, earners == pool)
//     is held at its rate: its earners grow with the pool by definition.
//
//   * Median rate = 100 * e_hat / N_hat. The spread lives on the logit
//     scale (the scale the loss is scored on) and combines three terms:
//     the random-walk term 0.5 * sqrt(horizon days) the house baseline
//     uses, the scatter of the two fits, and a floor that shrinks as the
//     number of distinct snapshots grows — a frozen or short history
//     earns a much wider band, because the one event that matters (the
//     next refresh, with its denominator dilution) is exactly the one a
//     flat history cannot see. Quantiles are the normal z values at the
//     case's levels, mapped back through the inverse logit.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const EPOCH_MS = Date.UTC(2026, 10, 19, 0, 0, 0); // 2026-11-19T00:00:00Z
const Z_LEVELS = [-1.645, -0.674, 0, 0.674, 1.645];
// Median earn-rate prior (percent) for a trophy with no earners yet, by
// tier: by a week after launch even a rare trophy has some earners among
// tens of thousands of tracked players, the platinum fewest.
const ZERO_PRIOR: { [tier: string]: number } = {
  platinum: 0.01,
  gold: 0.02,
  silver: 0.04,
  bronze: 0.06,
};

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function logit(pct: number): number {
  const p = clamp(pct, 0.01, 99.99) / 100;
  return Math.log(p / (1 - p));
}

function invLogit(x: number): number {
  return 100 / (1 + Math.exp(-x));
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

interface Snap {
  t: number; // hours since EPOCH_MS (may be slightly negative pre-launch)
  n: number; // players tracked
  rates: (number | null)[];
}

interface Fit {
  pred: number;
  resid: number; // weighted residual standard deviation
  slope: number;
}

// Weighted least squares y ~ a + b*x, predicted at xT.
function fitPredict(xs: number[], ys: number[], ws: number[], xT: number): Fit {
  const n = xs.length;
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sw += ws[i];
    sx += ws[i] * xs[i];
    sy += ws[i] * ys[i];
  }
  const mx = sx / sw;
  const my = sy / sw;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    sxx += ws[i] * dx * dx;
    sxy += ws[i] * dx * (ys[i] - my);
  }
  const slope = sxx > 1e-12 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  let sr = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (intercept + slope * xs[i]);
    sr += ws[i] * r * r;
  }
  return { pred: intercept + slope * xT, resid: Math.sqrt(sr / sw), slope };
}

// How much the tracked pool is assumed to multiply over the horizon when
// the history holds a single frozen snapshot: a refresh is likely and
// launch-week growth is fast, saturating near 6.5x.
function frozenGrowth(hDays: number): number {
  return Math.min(8, 1 + 5.5 * (1 - Math.exp(-hDays / 0.6)));
}

// Logit-scale spread floor by the number of distinct snapshots: the less
// of the refresh cycle the history shows, the wider the honest band.
function sigmaFloor(nSnap: number): number {
  if (nSnap <= 1) return 1.5;
  if (nSnap === 2) return 1.1;
  if (nSnap <= 4) return 0.8;
  if (nSnap <= 8) return 0.55;
  return 0.35;
}

interface Trophy {
  id: number;
  tier: string;
}

interface CaseFile {
  id: string;
  target: string;
  horizon_minutes: number;
  trophies: Trophy[];
  history: { at: string; players_tracked: number; rates: (number | null)[] }[];
}

function forecastCase(c: CaseFile): { trophies: { id: number; q: number[] }[] } {
  const hDays = c.horizon_minutes / 1440;
  const tTarget = (Date.parse(c.target) - EPOCH_MS) / 3600000;
  const xTarget = Math.log(1 + Math.max(0, tTarget));

  // Dedupe the reads into refresh snapshots: a read identical to the
  // previous kept one (same pool, same rates) carries no new information.
  const snaps: Snap[] = [];
  let lastSig = "";
  for (const read of c.history) {
    const sig = read.players_tracked + "|" + read.rates.join(",");
    if (sig === lastSig) continue;
    lastSig = sig;
    snaps.push({
      t: (Date.parse(read.at) - EPOCH_MS) / 3600000,
      n: read.players_tracked,
      rates: read.rates,
    });
  }

  const sigmaRW = 0.5 * Math.sqrt(hDays);
  const floor = sigmaFloor(snaps.length);

  // ---- players tracked at the target ----
  let nHat = 1000;
  let residN = 0.35;
  if (snaps.length >= 2) {
    const tLast = snaps[snaps.length - 1].t;
    const xs = snaps.map((s) => Math.log(1 + Math.max(0, s.t)));
    const ys = snaps.map((s) => Math.log(Math.max(1, s.n)));
    const ws = snaps.map((s) => Math.pow(0.5, Math.max(0, tLast - s.t) / 48));
    const fit = fitPredict(xs, ys, ws, xTarget);
    const nLast = snaps[snaps.length - 1].n;
    nHat = clamp(Math.exp(fit.pred), nLast, nLast * 60);
    residN = fit.resid;
  } else if (snaps.length === 1) {
    nHat = snaps[0].n * frozenGrowth(hDays);
  }

  const rows: { id: number; q: number[] }[] = [];

  for (let j = 0; j < c.trophies.length; j++) {
    const trophy = c.trophies[j];

    // Last non-null rate and the earner series over snapshots.
    let lastRate: number | null = null;
    const pts: { x: number; e: number; t: number }[] = [];
    for (const s of snaps) {
      const r = s.rates[j];
      if (r === null || r === undefined) continue;
      lastRate = r;
      pts.push({ x: Math.log(1 + Math.max(0, s.t)), e: (r / 100) * s.n, t: s.t });
    }

    let median: number;
    let sigma: number;

    if (lastRate === null || pts.length === 0) {
      // Never seen earned (or never listed): tier prior, wide band.
      median = ZERO_PRIOR[trophy.tier] ?? 0.05;
      sigma = Math.sqrt(sigmaRW * sigmaRW + floor * floor) + 0.5;
    } else {
      const eLast = pts[pts.length - 1].e;

      // ---- earners at the target ----
      let eHat = eLast;
      let residE = 0.3;
      let fitUsed = false;
      if (pts.length >= 2) {
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => Math.log(1 + p.e));
        const ws = pts.map((p) => Math.pow(0.5, Math.max(0, pts[pts.length - 1].t - p.t) / 48));
        const xRange = Math.max(...xs) - Math.min(...xs);
        if (xRange > 1e-9) {
          const fit = fitPredict(xs, ys, ws, xTarget);
          eHat = Math.exp(fit.pred) - 1;
          residE = fit.resid;
          fitUsed = true;
        }
      }
      if (!fitUsed) {
        // No trend to fit: the tracked cohort keeps earning over the
        // horizon, just slower than the pool grows (frozenGrowth's time
        // constant, a smaller amplitude).
        eHat = eLast * (1 + 0.8 * (1 - Math.exp(-hDays / 0.6)));
      }
      eHat = clamp(eHat, eLast, nHat); // earners never fall, never exceed the pool

      const sigmaFit = Math.min(1.25, Math.sqrt(residE * residE + residN * residN));
      sigma = Math.sqrt(sigmaRW * sigmaRW + sigmaFit * sigmaFit + floor * floor);
      if (eLast === 0) sigma += 0.3; // a zero count can jump furthest

      if (lastRate >= 99.9) {
        // Saturated: every tracked player holds it, so its earners grow
        // with the pool and the rate stays where it is; keep the band
        // tight and just under the cap.
        median = Math.min(lastRate, 99.99);
        sigma = clamp(0.35 * sigma, 0.3, 0.8);
      } else if (eLast === 0 && eHat <= 0.5) {
        median = Math.max((100 * eHat) / nHat, ZERO_PRIOR[trophy.tier] ?? 0.05);
      } else {
        median = (100 * eHat) / nHat;
      }
    }

    median = clamp(median, 0.005, 99.99);
    const centre = logit(median);
    const q: number[] = [];
    let prev = 0;
    for (const z of Z_LEVELS) {
      let v = round4(invLogit(centre + z * sigma));
      v = clamp(v, 0, 100);
      if (v < prev) v = prev; // quantiles never decrease
      q.push(v);
      prev = v;
    }
    rows.push({ id: trophy.id, q });
  }

  return { trophies: rows };
}

function main(): void {
  const inDir = process.env.MAKEFUN_INPUT_DIR || "/input";
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  mkdirSync(outDir, { recursive: true });
  const files = readdirSync(inDir)
    .filter((f) => f.endsWith(".in"))
    .sort();
  for (const f of files) {
    const c = JSON.parse(readFileSync(join(inDir, f), "utf8")) as CaseFile;
    const out = forecastCase(c);
    writeFileSync(join(outDir, c.id + ".out"), JSON.stringify(out));
  }
}

main();
