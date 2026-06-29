// Widmark-based BAC modelling. Shared by client (live + history charts) and
// usable on the server. Pure functions, no I/O, fully unit-testable.

import type { Entry, Profile } from "./types.js";

/** Density of ethanol in g/mL. */
export const ETHANOL_DENSITY = 0.789;

/** Default Widmark distribution factors (population averages). */
export const DEFAULT_R_MALE = 0.68;
export const DEFAULT_R_FEMALE = 0.55;

/** Grams of pure ethanol in a drink of the given volume (mL) and ABV (%). */
export function gramsOfAlcohol(volumeMl: number, abv: number): number {
  return volumeMl * (abv / 100) * ETHANOL_DENSITY;
}

/** Resolve the Widmark r factor for a profile, honouring any manual override. */
export function widmarkR(profile: Profile): number {
  if (typeof profile.rOverride === "number" && profile.rOverride > 0) {
    return profile.rOverride;
  }
  return profile.sex === "female" ? DEFAULT_R_FEMALE : DEFAULT_R_MALE;
}

/**
 * Peak BAC contribution (in %) of a single fully-absorbed drink, before any
 * elimination. This is the Widmark equation:
 *   BAC% = gramsAlcohol / (bodyWeightGrams * r) * 100
 */
export function peakBacContribution(gramsAlcohol: number, profile: Profile): number {
  const bodyWeightGrams = profile.weightKg * 1000;
  const r = widmarkR(profile);
  return (gramsAlcohol / (bodyWeightGrams * r)) * 100;
}

/**
 * The fraction (0..1) of a drink that has been absorbed into the bloodstream
 * at `elapsedMs` after consumption, modelled as a linear ramp over the
 * profile's absorption window.
 */
function absorbedFraction(elapsedMs: number, absorptionMinutes: number): number {
  if (elapsedMs <= 0) return 0;
  const windowMs = absorptionMinutes * 60_000;
  if (windowMs <= 0) return 1; // instantaneous absorption
  return Math.min(1, elapsedMs / windowMs);
}

/** Absorbed BAC (%) a single entry has contributed by `atMs`, ignoring
 *  elimination. Absorption stacks across drinks; elimination does not. */
export function entryAbsorbedBacAt(entry: Entry, profile: Profile, atMs: number): number {
  const startMs = new Date(entry.timestamp).getTime();
  const elapsedMs = atMs - startMs;
  if (elapsedMs <= 0) return 0;
  const peak = peakBacContribution(entry.gramsAlcohol, profile);
  return absorbedFraction(elapsedMs, profile.absorptionMinutes) * peak;
}

/**
 * Total BAC (%) across all entries at a given absolute time.
 *
 * Alcohol elimination is zero-order: the body clears at a roughly constant
 * rate (beta %/hr) regardless of how many drinks are present. We therefore
 * integrate one shared elimination — not one per drink — and floor BAC at 0
 * within each segment so that sober gaps between sessions reset correctly
 * (important for multi-night history). Absorption, by contrast, accumulates
 * across all drinks.
 */
export function totalBacAt(entries: Entry[], profile: Profile, atMs: number): number {
  if (entries.length === 0) return 0;

  const windowMs = Math.max(0, profile.absorptionMinutes) * 60_000;
  const betaPerMs = profile.betaRate / 3_600_000;

  const drinks = entries
    .map((e) => ({
      start: new Date(e.timestamp).getTime(),
      peak: peakBacContribution(e.gramsAlcohol, profile)
    }))
    .filter((d) => d.start <= atMs)
    .sort((a, b) => a.start - b.start);

  if (drinks.length === 0) return 0;
  const firstStart = drinks[0].start;

  // Breakpoints where the absorption slope changes: each drink's start and the
  // end of its absorption window. BAC is piecewise-linear between these.
  const breaks = new Set<number>([firstStart, atMs]);
  for (const d of drinks) {
    if (d.start <= atMs) breaks.add(d.start);
    if (windowMs > 0 && d.start + windowMs <= atMs) breaks.add(d.start + windowMs);
  }
  const times = [...breaks].filter((t) => t >= firstStart && t <= atMs).sort((a, b) => a - b);

  let bac = 0;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];

    // Instantaneous absorption (window = 0): add the full peak at the start.
    if (windowMs === 0) {
      for (const d of drinks) if (d.start === t) bac += d.peak;
    }

    if (i + 1 < times.length) {
      const dt = times[i + 1] - t;
      // Absorption rate is constant within a segment (breakpoints fall exactly
      // on window edges), so sum the active drinks' ramp rates.
      let absRate = 0;
      if (windowMs > 0) {
        for (const d of drinks) {
          if (t >= d.start && t < d.start + windowMs) absRate += d.peak / windowMs;
        }
      }
      const netRate = absRate - betaPerMs;
      bac = Math.max(0, bac + netRate * dt);
    }
  }

  return Math.max(0, bac);
}

export interface BacPoint {
  t: number; // epoch ms
  bac: number;
}

/**
 * Sample the BAC curve across [startMs, endMs] at a fixed step. Used to draw
 * the continuous solid/projected curve. Returns evenly spaced points.
 */
export function sampleBacCurve(
  entries: Entry[],
  profile: Profile,
  startMs: number,
  endMs: number,
  stepMs: number
): BacPoint[] {
  const points: BacPoint[] = [];
  if (endMs < startMs) return points;
  for (let t = startMs; t <= endMs; t += stepMs) {
    points.push({ t, bac: totalBacAt(entries, profile, t) });
  }
  // Always include the exact end so the curve terminates cleanly.
  if (points.length === 0 || points[points.length - 1].t !== endMs) {
    points.push({ t: endMs, bac: totalBacAt(entries, profile, endMs) });
  }
  return points;
}

/**
 * Estimate the absolute time (epoch ms) at which BAC falls to `target`%,
 * searching forward from `fromMs`. Returns `null` if BAC is already at or
 * below `target`. The search expands an upper bound then binary-searches the
 * crossing, since the curve is monotonic once all drinks are fully absorbed.
 */
export function estimateTimeAtBac(
  entries: Entry[],
  profile: Profile,
  fromMs: number,
  target: number
): number | null {
  const current = totalBacAt(entries, profile, fromMs);
  if (current <= target) return null;

  // Upper bound: BAC above target eliminated, plus the absorption window for
  // any not-yet-absorbed drinks. Add a generous margin.
  const hoursToTarget = (current - target) / profile.betaRate;
  let hi = fromMs + (hoursToTarget + profile.absorptionMinutes / 60 + 1) * 3_600_000;

  // Expand if (due to still-absorbing drinks) BAC isn't below target yet at hi.
  let guard = 0;
  while (totalBacAt(entries, profile, hi) > target && guard < 100) {
    hi += 3_600_000;
    guard++;
  }

  // Binary search for the crossing point between fromMs and hi.
  let lo = fromMs;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (totalBacAt(entries, profile, mid) > target) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return hi;
}

/**
 * Estimate the absolute time (epoch ms) at which BAC returns to ~0. Returns
 * `fromMs` if already sober.
 */
export function estimateSoberTime(entries: Entry[], profile: Profile, fromMs: number): number {
  return estimateTimeAtBac(entries, profile, fromMs, 0.0001) ?? fromMs;
}

export interface BacSummary {
  currentBac: number;
  soberAtMs: number | null;
  msUntilSober: number;
}

/** Convenience bundle for the live headline ("Sober at ~HH:MM"). */
export function bacSummary(entries: Entry[], profile: Profile, nowMs: number): BacSummary {
  const currentBac = totalBacAt(entries, profile, nowMs);
  if (currentBac <= 0) {
    return { currentBac: 0, soberAtMs: null, msUntilSober: 0 };
  }
  const soberAtMs = estimateSoberTime(entries, profile, nowMs);
  return { currentBac, soberAtMs, msUntilSober: Math.max(0, soberAtMs - nowMs) };
}

// ---------------------------------------------------------------------------
// Nightly grouping helpers
// ---------------------------------------------------------------------------

/**
 * Return a YYYY-MM-DD key identifying the "night" an entry belongs to. A night
 * begins at `dayStartHour` local time, so e.g. a 2 AM drink (with default
 * dayStartHour=4) is attributed to the previous calendar date.
 */
export function nightKey(timestamp: string, dayStartHour: number): string {
  const d = new Date(timestamp);
  const shifted = new Date(d.getTime() - dayStartHour * 3_600_000);
  const y = shifted.getFullYear();
  const m = String(shifted.getMonth() + 1).padStart(2, "0");
  const day = String(shifted.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface NightGroup {
  key: string; // YYYY-MM-DD
  entries: Entry[];
}

/** Group entries by night, sorted chronologically (oldest first). */
export function groupByNight(entries: Entry[], dayStartHour: number): NightGroup[] {
  const map = new Map<string, Entry[]>();
  for (const e of entries) {
    const key = nightKey(e.timestamp, dayStartHour);
    const bucket = map.get(key);
    if (bucket) bucket.push(e);
    else map.set(key, [e]);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, es]) => ({ key, entries: es }));
}

/**
 * Compute the peak BAC reached during a set of entries by sampling from the
 * first drink to a few hours after the last.
 */
export function peakBacForEntries(entries: Entry[], profile: Profile): number {
  if (entries.length === 0) return 0;
  const times = entries.map((e) => new Date(e.timestamp).getTime());
  const start = Math.min(...times);
  const end = Math.max(...times) + 12 * 3_600_000;
  let peak = 0;
  const step = 5 * 60_000; // 5-minute resolution
  for (let t = start; t <= end; t += step) {
    const bac = totalBacAt(entries, profile, t);
    if (bac > peak) peak = bac;
  }
  return peak;
}
