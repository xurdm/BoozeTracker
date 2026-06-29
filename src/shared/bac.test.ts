import { describe, expect, it } from "vitest";
import {
  bacSummary,
  estimateSoberTime,
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
