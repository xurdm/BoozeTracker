// History page: several charts over historical data, each filterable by a
// Day/Week/Month/All range control.

import { fetchEntries, fetchProfile } from "./api.js";
import {
  barChartOptions,
  buildRangeControls,
  Chart,
  lineChartOptions,
  rangeMs,
  type RangeKey
} from "./charts.js";
import {
  groupByNight,
  peakBacForEntries,
  sampleBacCurve
} from "../shared/bac.js";
import { categorizeDrink, DRINK_TYPES, type DrinkType } from "../shared/presets.js";
import { DEFAULT_PROFILE, type Entry, type Profile } from "../shared/types.js";

// Consistent colour per drink type across the type charts.
const TYPE_COLORS: Record<DrinkType, string> = {
  Beer: "#f59e0b",
  Wine: "#ef4444",
  Liquor: "#7c4dff",
  Cocktail: "#10b981",
  Other: "#64748b"
};

let profile: Profile = { ...DEFAULT_PROFILE };
let entries: Entry[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChartInstance = any;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

function filterByRange(range: RangeKey): Entry[] {
  const span = rangeMs(range);
  if (span === null) return entries;
  const cutoff = Date.now() - span;
  return entries.filter((e) => new Date(e.timestamp).getTime() >= cutoff);
}

function nightLabels(keys: string[]): string[] {
  return keys.map((k) => {
    const d = new Date(`${k}T12:00:00`);
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  });
}

// --- chart 1: BAC over time ---------------------------------------------

let bacChart: ChartInstance | null = null;
const bacSpanRef = { value: 24 * 3_600_000 };

function renderBacOverTime(range: RangeKey): void {
  const data = filterByRange(range);
  const times = data.map((e) => new Date(e.timestamp).getTime());
  const now = Date.now();
  const start = times.length ? Math.min(...times) : now - 24 * 3_600_000;
  const end = times.length ? Math.max(...times) + 12 * 3_600_000 : now;
  bacSpanRef.value = end - start;

  const step = Math.max(5 * 60_000, Math.round((end - start) / 500));
  const points = sampleBacCurve(data, profile, start, end, step).map((p) => ({
    x: p.t,
    y: p.bac
  }));

  const dataset = {
    label: "BAC %",
    data: points,
    borderColor: "#7c4dff",
    backgroundColor: "rgba(124, 77, 255, 0.15)",
    borderWidth: 2,
    fill: true,
    tension: 0.25,
    pointRadius: 0
  };

  if (bacChart) {
    bacChart.data.datasets = [dataset];
    bacChart.update();
  } else {
    bacChart = new Chart($<HTMLCanvasElement>("bac-chart").getContext("2d"), {
      type: "line",
      data: { datasets: [dataset] },
      options: lineChartOptions(bacSpanRef, "BAC %")
    });
  }
}

// --- chart 2: drinks per night ------------------------------------------

let drinksChart: ChartInstance | null = null;

function renderDrinksPerNight(range: RangeKey): void {
  const groups = groupByNight(filterByRange(range), profile.dayStartHour);
  const labels = nightLabels(groups.map((g) => g.key));
  const counts = groups.map((g) => g.entries.length);

  const dataset = {
    label: "Drinks",
    data: counts,
    backgroundColor: "#7c4dff"
  };

  if (drinksChart) {
    drinksChart.data.labels = labels;
    drinksChart.data.datasets = [dataset];
    drinksChart.update();
  } else {
    drinksChart = new Chart($<HTMLCanvasElement>("drinks-chart").getContext("2d"), {
      type: "bar",
      data: { labels, datasets: [dataset] },
      options: barChartOptions("Drinks")
    });
  }
}

// --- chart 3: peak BAC per night ----------------------------------------

let peakChart: ChartInstance | null = null;

function renderPeakBac(range: RangeKey): void {
  const groups = groupByNight(filterByRange(range), profile.dayStartHour);
  const labels = nightLabels(groups.map((g) => g.key));
  const peaks = groups.map((g) => Number(peakBacForEntries(g.entries, profile).toFixed(4)));

  const dataset = {
    label: "Peak BAC %",
    data: peaks,
    backgroundColor: "#9d7bff"
  };

  if (peakChart) {
    peakChart.data.labels = labels;
    peakChart.data.datasets = [dataset];
    peakChart.update();
  } else {
    peakChart = new Chart($<HTMLCanvasElement>("peak-chart").getContext("2d"), {
      type: "bar",
      data: { labels, datasets: [dataset] },
      options: barChartOptions("Peak BAC %")
    });
  }
}

// --- chart 4: total alcohol (g) per night + 7-night rolling average -----

let gramsChart: ChartInstance | null = null;

function rollingAverage(values: number[], window: number): Array<number | null> {
  return values.map((_, i) => {
    if (i < window - 1) return null;
    let sum = 0;
    for (let j = i - window + 1; j <= i; j++) sum += values[j];
    return Number((sum / window).toFixed(2));
  });
}

function renderGramsPerNight(range: RangeKey): void {
  const groups = groupByNight(filterByRange(range), profile.dayStartHour);
  const labels = nightLabels(groups.map((g) => g.key));
  const grams = groups.map((g) =>
    Number(g.entries.reduce((s, e) => s + e.gramsAlcohol, 0).toFixed(1))
  );
  const avg = rollingAverage(grams, 7);

  const datasets = [
    { type: "bar", label: "Alcohol (g)", data: grams, backgroundColor: "#7c4dff", order: 2 },
    {
      type: "line",
      label: "7-night avg",
      data: avg,
      borderColor: "#f59e0b",
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.3,
      spanGaps: true,
      order: 1
    }
  ];

  if (gramsChart) {
    gramsChart.data.labels = labels;
    gramsChart.data.datasets = datasets;
    gramsChart.update();
  } else {
    gramsChart = new Chart($<HTMLCanvasElement>("grams-chart").getContext("2d"), {
      type: "bar",
      data: { labels, datasets },
      options: barChartOptions("Alcohol (g)")
    });
  }
}

// --- chart 5: average drinks by day of week -----------------------------

let dowChart: ChartInstance | null = null;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function renderByDayOfWeek(range: RangeKey): void {
  const groups = groupByNight(filterByRange(range), profile.dayStartHour);
  const totals = new Array(7).fill(0);
  const nights = new Array(7).fill(0);

  for (const g of groups) {
    const dow = new Date(`${g.key}T12:00:00`).getDay();
    totals[dow] += g.entries.length;
    nights[dow] += 1;
  }
  const avg = totals.map((t, i) => (nights[i] ? Number((t / nights[i]).toFixed(2)) : 0));

  const dataset = { label: "Avg drinks / night", data: avg, backgroundColor: "#7c4dff" };

  if (dowChart) {
    dowChart.data.datasets = [dataset];
    dowChart.update();
  } else {
    dowChart = new Chart($<HTMLCanvasElement>("dow-chart").getContext("2d"), {
      type: "bar",
      data: { labels: DOW, datasets: [dataset] },
      options: barChartOptions("Avg drinks / night")
    });
  }
}

// --- chart 6: drinks by type (doughnut) ---------------------------------

let typeChart: ChartInstance | null = null;

function renderDrinksByType(range: RangeKey): void {
  const counts = new Map<DrinkType, number>();
  for (const e of filterByRange(range)) {
    const type = categorizeDrink(e.label, e.abv);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const types = DRINK_TYPES.filter((t) => (counts.get(t) ?? 0) > 0);
  const data = types.map((t) => counts.get(t) ?? 0);
  const colors = types.map((t) => TYPE_COLORS[t]);

  const dataset = { data, backgroundColor: colors, borderColor: "#0f172a", borderWidth: 2 };

  if (typeChart) {
    typeChart.data.labels = types;
    typeChart.data.datasets = [dataset];
    typeChart.update();
  } else {
    typeChart = new Chart($<HTMLCanvasElement>("type-chart").getContext("2d"), {
      type: "doughnut",
      data: { labels: types, datasets: [dataset] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "right", labels: { color: "rgba(148,163,184,0.9)" } } }
      }
    });
  }
}

// --- chart 7: alcohol (g) by type per night (stacked bar) ---------------

let typeNightChart: ChartInstance | null = null;

function renderGramsByTypePerNight(range: RangeKey): void {
  const groups = groupByNight(filterByRange(range), profile.dayStartHour);
  const labels = nightLabels(groups.map((g) => g.key));

  const datasets = DRINK_TYPES.map((type) => ({
    label: type,
    data: groups.map((g) =>
      Number(
        g.entries
          .filter((e) => categorizeDrink(e.label, e.abv) === type)
          .reduce((s, e) => s + e.gramsAlcohol, 0)
          .toFixed(1)
      )
    ),
    backgroundColor: TYPE_COLORS[type],
    stack: "alcohol"
  })).filter((ds) => ds.data.some((v) => v > 0));

  if (typeNightChart) {
    typeNightChart.data.labels = labels;
    typeNightChart.data.datasets = datasets;
    typeNightChart.update();
  } else {
    const opts = barChartOptions("Alcohol (g)");
    opts.scales.x = { ...opts.scales.x, stacked: true } as typeof opts.scales.x;
    opts.scales.y = { ...opts.scales.y, stacked: true } as typeof opts.scales.y;
    typeNightChart = new Chart($<HTMLCanvasElement>("typenight-chart").getContext("2d"), {
      type: "bar",
      data: { labels, datasets },
      options: opts
    });
  }
}

// --- wiring --------------------------------------------------------------

function renderAll(range: RangeKey): void {
  renderBacOverTime(range);
  renderDrinksPerNight(range);
  renderPeakBac(range);
  renderGramsPerNight(range);
  renderByDayOfWeek(range);
  renderDrinksByType(range);
  renderGramsByTypePerNight(range);
}

async function init(): Promise<void> {
  try {
    [profile, entries] = await Promise.all([fetchProfile(), fetchEntries()]);
  } catch {
    // Leave defaults; charts will simply be empty.
  }

  const initial: RangeKey = "week";
  // Independent range control per chart so each can be explored separately.
  buildRangeControls($("range-bac"), initial, renderBacOverTime);
  buildRangeControls($("range-drinks"), initial, renderDrinksPerNight);
  buildRangeControls($("range-peak"), initial, renderPeakBac);
  buildRangeControls($("range-grams"), initial, renderGramsPerNight);
  buildRangeControls($("range-dow"), "all", renderByDayOfWeek);
  buildRangeControls($("range-type"), initial, renderDrinksByType);
  buildRangeControls($("range-typenight"), initial, renderGramsByTypePerNight);

  renderAll(initial);
  renderByDayOfWeek("all");
}

init();
