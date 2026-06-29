import { describe, expect, it } from "vitest";
import {
  bacSummary,
  estimateSoberTime,
  estimateTimeAtBac,
  gramsOfAlcohol,
  groupByNight,
  nightKey,
  peakBacContribution,
  totalBacAt,
  widmarkR
} from "./bac.js";
import { categorizeDrink } from "./presets.js";
import { DEFAULT_PROFILE, type Entry, type Profile } from "./types.js";

const maleProfile: Profile = { ...DEFAULT_PROFILE, weightKg: 81.6, sex: "male" }; // ~180 lb

function entryAt(iso: string, volumeMl: number, abv: number): Entry {
  return {
    id: iso,
    timestamp: iso,
    volumeMl,
    abv,
    gramsAlcohol: gramsOfAlcohol(volumeMl, abv)
  };
}

describe("gramsOfAlcohol", () => {
  it("computes ~14 g for a US standard drink (12oz 5% beer)", () => {
    const g = gramsOfAlcohol(355, 5);
    expect(g).toBeGreaterThan(13);
    expect(g).toBeLessThan(15);
  });
});

describe("widmarkR", () => {
  it("uses sex defaults", () => {
    expect(widmarkR({ ...maleProfile, sex: "male" })).toBeCloseTo(0.68);
    expect(widmarkR({ ...maleProfile, sex: "female" })).toBeCloseTo(0.55);
  });
  it("honours an override", () => {
    expect(widmarkR({ ...maleProfile, rOverride: 0.6 })).toBeCloseTo(0.6);
  });
});

describe("peakBacContribution", () => {
  it("a standard drink raises a 180lb male ~0.02-0.03%", () => {
    const g = gramsOfAlcohol(355, 5);
    const peak = peakBacContribution(g, maleProfile);
    expect(peak).toBeGreaterThan(0.02);
    expect(peak).toBeLessThan(0.03);
  });
});

describe("totalBacAt", () => {
  it("is zero before the drink", () => {
    const e = entryAt("2026-01-01T20:00:00Z", 355, 5);
    expect(totalBacAt([e], maleProfile, Date.parse("2026-01-01T19:00:00Z"))).toBe(0);
  });

  it("declines over time and reaches zero", () => {
    const e = entryAt("2026-01-01T20:00:00Z", 355, 5);
    const justAfter = Date.parse("2026-01-01T21:00:00Z");
    const muchLater = Date.parse("2026-01-02T06:00:00Z");
    expect(totalBacAt([e], maleProfile, justAfter)).toBeGreaterThan(0);
    expect(totalBacAt([e], maleProfile, muchLater)).toBe(0);
  });
});

describe("elimination is zero-order (shared, not per-drink)", () => {
  it("declines at ~beta total regardless of drink count", () => {
    // Five identical drinks at the same instant.
    const ts = "2026-01-01T20:00:00Z";
    const drinks = Array.from({ length: 5 }, (_, i) => ({
      ...entryAt(ts, 355, 5),
      id: `d${i}`
    }));
    // Well after absorption completes, the curve should drop by ~beta per hour.
    const t1 = Date.parse("2026-01-01T22:00:00Z");
    const t2 = Date.parse("2026-01-01T23:00:00Z");
    const b1 = totalBacAt(drinks, maleProfile, t1);
    const b2 = totalBacAt(drinks, maleProfile, t2);
    expect(b1 - b2).toBeCloseTo(maleProfile.betaRate, 3);
  });

  it("sober time scales with total alcohol, not number of drinks", () => {
    const ts = "2026-01-01T20:00:00Z";
    const tsMs = Date.parse(ts);
    const after = tsMs + 60 * 60_000; // 1h later, fully absorbed, still drunk
    const one = [entryAt(ts, 355, 5)];
    const four = Array.from({ length: 4 }, (_, i) => ({ ...entryAt(ts, 355, 5), id: `d${i}` }));
    const soberOne = estimateSoberTime(one, maleProfile, after) - tsMs;
    const soberFour = estimateSoberTime(four, maleProfile, after) - tsMs;
    // 4x the alcohol should take roughly 4x as long to clear (not the same).
    expect(soberFour / soberOne).toBeGreaterThan(3.5);
  });
});

describe("sober gaps between sessions reset BAC", () => {
  it("returns to zero between two distant drinks", () => {
    const night1 = entryAt("2026-01-01T20:00:00Z", 355, 5);
    const night2 = entryAt("2026-01-02T20:00:00Z", 355, 5);
    const entries = [night1, night2];
    // Mid-day between sessions: should be fully sober.
    expect(totalBacAt(entries, maleProfile, Date.parse("2026-01-02T12:00:00Z"))).toBe(0);
    // Shortly after the second drink: should reflect a fresh single drink, not
    // be wiped out by a day's worth of accumulated elimination.
    const after2 = totalBacAt(entries, maleProfile, Date.parse("2026-01-02T20:45:00Z"));
    const fresh = totalBacAt([night2], maleProfile, Date.parse("2026-01-02T20:45:00Z"));
    expect(after2).toBeCloseTo(fresh, 5);
    expect(after2).toBeGreaterThan(0);
  });
});

describe("estimateSoberTime", () => {
  it("returns now when already sober", () => {
    const now = Date.now();
    expect(estimateSoberTime([], maleProfile, now)).toBe(now);
  });

  it("finds a crossing where BAC is ~0", () => {
    const e = entryAt("2026-01-01T20:00:00Z", 355, 5);
    const now = Date.parse("2026-01-01T21:00:00Z");
    const sober = estimateSoberTime([e], maleProfile, now);
    expect(sober).toBeGreaterThan(now);
    expect(totalBacAt([e], maleProfile, sober)).toBeLessThan(0.001);
  });
});

describe("estimateTimeAtBac", () => {
  it("returns null when already below the target", () => {
    const e = entryAt("2026-01-01T20:00:00Z", 355, 5);
    // A single standard drink never reaches 0.08%.
    const at = Date.parse("2026-01-01T21:00:00Z");
    expect(estimateTimeAtBac([e], maleProfile, at, 0.08)).toBeNull();
  });

  it("finds the descending crossing of a threshold", () => {
    // Enough drinks to clear 0.08%.
    const ts = "2026-01-01T20:00:00Z";
    const drinks = Array.from({ length: 8 }, (_, i) => ({ ...entryAt(ts, 355, 5), id: `d${i}` }));
    const at = Date.parse("2026-01-01T21:00:00Z");
    const cross = estimateTimeAtBac(drinks, maleProfile, at, 0.08);
    expect(cross).not.toBeNull();
    expect(totalBacAt(drinks, maleProfile, cross as number)).toBeCloseTo(0.08, 3);
    expect(cross as number).toBeGreaterThan(at);
  });
});

describe("bacSummary", () => {
  it("reports sober when no drinks", () => {
    const s = bacSummary([], maleProfile, Date.now());
    expect(s.currentBac).toBe(0);
    expect(s.soberAtMs).toBeNull();
  });
});

describe("categorizeDrink", () => {
  it("matches by label keyword", () => {
    expect(categorizeDrink("Beer 12oz 5%", 5)).toBe("Beer");
    expect(categorizeDrink("IPA 12oz 8%", 8)).toBe("Beer");
    expect(categorizeDrink("Wine 5oz 12%", 12)).toBe("Wine");
    expect(categorizeDrink("Shot 1.5oz 40%", 40)).toBe("Liquor");
    expect(categorizeDrink("Cocktail 8oz 12%", 12)).toBe("Cocktail");
  });

  it("falls back to ABV for unlabelled custom combos", () => {
    expect(categorizeDrink(undefined, 40)).toBe("Liquor");
    expect(categorizeDrink("355 mL @ 5%", 5)).toBe("Beer");
    expect(categorizeDrink("148 mL @ 12%", 12)).toBe("Wine");
  });
});

describe("nightKey / groupByNight", () => {
  it("attributes a 2 AM drink to the previous date with dayStartHour=4", () => {
    // Use a local-time timestamp to exercise the local-time shift.
    const lateNight = new Date(2026, 0, 2, 2, 0, 0).toISOString(); // Jan 2, 2:00 AM local
    expect(nightKey(lateNight, 4)).toBe("2026-01-01");
  });

  it("attributes an 8 PM drink to the same date", () => {
    const evening = new Date(2026, 0, 1, 20, 0, 0).toISOString();
    expect(nightKey(evening, 4)).toBe("2026-01-01");
  });

  it("groups entries into nights", () => {
    const a = entryAt(new Date(2026, 0, 1, 21, 0, 0).toISOString(), 355, 5);
    const b = entryAt(new Date(2026, 0, 2, 1, 0, 0).toISOString(), 355, 5); // same night
    const c = entryAt(new Date(2026, 0, 3, 22, 0, 0).toISOString(), 355, 5);
    const groups = groupByNight([a, b, c], 4);
    expect(groups.length).toBe(2);
    expect(groups[0].entries.length).toBe(2);
    expect(groups[1].entries.length).toBe(1);
  });
});
