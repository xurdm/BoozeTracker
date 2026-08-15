// History page: several charts over historical data, each filterable by a
// Day/Week/Month/All range control.

import { deleteEntry, fetchEntries, fetchProfile } from "./api.js";
import {
  barChartOptions,
  buildRangeControls,
  Chart,
  lineChartOptions,
  rangeMs,
  type RangeKey
} from "./charts.js";
import {
  estimateTimeAtBac,
  groupByNight,
  peakBacForEntries,
  sampleBacCurve,
  totalBacAt
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

// --- night detail: a single night's BAC curve (like the Tonight tab) -----

let nightChart: ChartInstance | null = null;
const nightSpanRef = { value: 12 * 3_600_000 };
let selectedNightKey: string | null = null;

interface DrinkMarker {
  x: number;
  y: number;
  drinks: string[];
}

/** Per-minute drink markers for a night, positioned on its BAC curve. */
function buildNightMarkers(nightEntries: Entry[]): DrinkMarker[] {
  const buckets = new Map<number, Map<string, number>>();
  for (const e of nightEntries) {
    const t = new Date(e.timestamp).getTime();
    const bucket = Math.round(t / 60_000) * 60_000;
    const labels = buckets.get(bucket) ?? new Map<string, number>();
    const name = e.label ?? `${Math.round(e.volumeMl)} mL @ ${e.abv}%`;
    labels.set(name, (labels.get(name) ?? 0) + 1);
    buckets.set(bucket, labels);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, labels]) => ({
      x: bucket,
      y: totalBacAt(nightEntries, profile, bucket),
      drinks: [...labels.entries()].map(([name, n]) => (n > 1 ? `🍹 ${name} ×${n}` : `🍹 ${name}`))
    }));
}

function selectNight(key: string): void {
  selectedNightKey = key;
  renderNightDetail();
  $("night-detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderNightDetail(): void {
  const nights = groupByNight(entries, profile.dayStartHour); // oldest → newest
  const summary = $("night-summary");
  const label = $("night-label");

  if (nights.length === 0) {
    label.textContent = "—";
    summary.textContent = "No entries yet.";
    (($("night-prev") as HTMLButtonElement).disabled = true),
      (($("night-next") as HTMLButtonElement).disabled = true);
    if (nightChart) {
      nightChart.data.datasets = [];
      nightChart.update();
    }
    return;
  }

  // Default to the most recent night; clamp if the selection vanished.
  let idx = nights.findIndex((n) => n.key === selectedNightKey);
  if (idx === -1) {
    idx = nights.length - 1;
    selectedNightKey = nights[idx].key;
  }
  const night = nights[idx];
  const nightEntries = night.entries;

  const times = nightEntries.map((e) => new Date(e.timestamp).getTime());
  const firstDrink = Math.min(...times);
  const lastDrink = Math.max(...times);
  const soberAt = estimateTimeAtBac(nightEntries, profile, lastDrink, 0.0001) ?? lastDrink;
  const start = firstDrink - 30 * 60_000;
  const end = soberAt + 15 * 60_000;
  nightSpanRef.value = end - start;

  const step = Math.max(60_000, Math.round((end - start) / 300));
  const curve = sampleBacCurve(nightEntries, profile, start, end, step).map((p) => ({
    x: p.t,
    y: p.bac
  }));

  // Peak + its time, and the 0.08% descending crossing (if reached).
  let peak = 0;
  let peakTime = firstDrink;
  for (const pt of curve) {
    if (pt.y > peak) {
      peak = pt.y;
      peakTime = pt.x;
    }
  }
  const datasets: unknown[] = [
    {
      label: "BAC %",
      data: curve,
      borderColor: "#7c4dff",
      backgroundColor: "rgba(124, 77, 255, 0.15)",
      borderWidth: 2,
      fill: true,
      tension: 0.25,
      pointRadius: 0
    },
    {
      label: "Drinks",
      type: "scatter",
      data: buildNightMarkers(nightEntries),
      backgroundColor: "#f59e0b",
      borderColor: "#1e293b",
      borderWidth: 2,
      pointRadius: 6,
      pointHoverRadius: 8,
      pointHitRadius: 12,
      showLine: false
    }
  ];

  const limitCross = peak > 0.08 ? estimateTimeAtBac(nightEntries, profile, peakTime, 0.08) : null;
  if (limitCross !== null && limitCross <= end) {
    const clock = new Date(limitCross).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    datasets.push({
      label: "0.08% limit",
      type: "scatter",
      data: [{ x: limitCross, y: 0.08, note: `Below 0.08% at ~${clock}` }],
      backgroundColor: "#ef4444",
      borderColor: "#fee2e2",
      borderWidth: 2,
      pointRadius: 7,
      pointHoverRadius: 9,
      pointHitRadius: 12,
      pointStyle: "rectRot",
      showLine: false
    });
  }

  if (nightChart) {
    nightChart.data.datasets = datasets;
    nightChart.options.scales.x.min = start;
    nightChart.options.scales.x.max = end;
    nightChart.update();
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options: any = lineChartOptions(nightSpanRef, "BAC %");
    options.elements = { point: { radius: 0 } };
    options.interaction = { mode: "nearest", intersect: true };
    options.plugins.tooltip.mode = "nearest";
    options.plugins.tooltip.intersect = true;
    options.plugins.tooltip.callbacks.label = (ctx: {
      raw?: { drinks?: string[]; note?: string };
      parsed: { y: number };
    }) => {
      if (ctx.raw && ctx.raw.note) return ctx.raw.note;
      const bac = `BAC: ${Number(ctx.parsed.y).toFixed(3)}%`;
      if (ctx.raw && ctx.raw.drinks) return [bac, ...ctx.raw.drinks];
      return bac;
    };
    options.scales.x.min = start;
    options.scales.x.max = end;
    nightChart = new Chart($<HTMLCanvasElement>("night-chart").getContext("2d"), {
      type: "line",
      data: { datasets },
      options
    });
  }

  // Label + summary.
  const dateStr = new Date(`${night.key}T12:00:00`).toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric"
  });
  label.textContent = dateStr;
  const totalG = nightEntries.reduce((s, e) => s + e.gramsAlcohol, 0);
  const soberClock = new Date(soberAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  summary.textContent = `${nightEntries.length} drink${nightEntries.length === 1 ? "" : "s"} · ${(totalG / 14).toFixed(1)} std · peak ${peak.toFixed(3)}% · sober ~${soberClock}`;

  ($("night-prev") as HTMLButtonElement).disabled = idx === 0;
  ($("night-next") as HTMLButtonElement).disabled = idx >= nights.length - 1;
}

function changeNight(delta: number): void {
  const nights = groupByNight(entries, profile.dayStartHour);
  let idx = nights.findIndex((n) => n.key === selectedNightKey);
  if (idx === -1) idx = nights.length - 1;
  idx = Math.min(Math.max(0, idx + delta), nights.length - 1);
  if (nights[idx]) selectNight(nights[idx].key);
}

/**
 * Make a per-night bar chart clickable: clicking a bar jumps the Night detail
 * view to that night. Maps the clicked bar's index to the night key using the
 * chart's current range (so it stays correct after range changes).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function attachNightClick(opts: any, key: keyof typeof current): void {
  opts.onClick = (_e: unknown, els: Array<{ index: number }>): void => {
    if (!els || els.length === 0) return;
    const groups = groupByNight(filterByRange(current[key]), profile.dayStartHour);
    const g = groups[els[0].index];
    if (g) selectNight(g.key);
  };
}

// --- chart 1: BAC over time ---------------------------------------------

let bacChart: ChartInstance | null = null;
const bacSpanRef = { value: 24 * 3_600_000 };

function renderBacOverTime(range: RangeKey): void {
  // The range controls only the visible window. BAC must be computed from ALL
  // entries — drinks before the window still contribute residual BAC inside it,
  // so filtering the entry set would truncate sessions and drop to 0 too early.
  const now = Date.now();
  const span = rangeMs(range);
  const times = entries.map((e) => new Date(e.timestamp).getTime());

  let start: number;
  let end: number;
  if (span === null) {
    // "All": span the full history plus a tail for the final decline.
    start = times.length ? Math.min(...times) : now - 24 * 3_600_000;
    end = times.length ? Math.max(...times) + 12 * 3_600_000 : now;
  } else {
    start = now - span;
    // Extend the end a little past now/last drink so the decline to 0 is shown.
    const lastDrink = times.length ? Math.max(...times) : now;
    end = Math.max(now, Math.min(lastDrink + 12 * 3_600_000, now + 12 * 3_600_000));
  }
  bacSpanRef.value = end - start;

  const step = Math.max(5 * 60_000, Math.round((end - start) / 500));
  const points = sampleBacCurve(entries, profile, start, end, step).map((p) => ({
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
    const opts = barChartOptions("Drinks");
    attachNightClick(opts, "drinks");
    drinksChart = new Chart($<HTMLCanvasElement>("drinks-chart").getContext("2d"), {
      type: "bar",
      data: { labels, datasets: [dataset] },
      options: opts
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
    const opts = barChartOptions("Peak BAC %");
    attachNightClick(opts, "peak");
    peakChart = new Chart($<HTMLCanvasElement>("peak-chart").getContext("2d"), {
      type: "bar",
      data: { labels, datasets: [dataset] },
      options: opts
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
    const opts = barChartOptions("Alcohol (g)");
    attachNightClick(opts, "grams");
    gramsChart = new Chart($<HTMLCanvasElement>("grams-chart").getContext("2d"), {
      type: "bar",
      data: { labels, datasets },
      options: opts
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
    attachNightClick(opts, "typenight");
    typeNightChart = new Chart($<HTMLCanvasElement>("typenight-chart").getContext("2d"), {
      type: "bar",
      data: { labels, datasets },
      options: opts
    });
  }
}

// --- chart 8: drinking clock (drinks by hour of day, polar area) ---------

let hourChart: ChartInstance | null = null;

function renderDrinkingClock(range: RangeKey): void {
  const counts = new Array(24).fill(0);
  for (const e of filterByRange(range)) counts[new Date(e.timestamp).getHours()]++;
  const labels = counts.map((_, h) => `${String(h).padStart(2, "0")}:00`);

  // Colour each hour sector by time-of-day: cool blues overnight, warm ambers
  // in the evening — purely aesthetic.
  const colors = counts.map((_, h) => {
    const hue = (210 + (h / 24) * 180) % 360; // sweep blue → magenta → amber
    return `hsla(${hue}, 70%, 60%, 0.55)`;
  });

  const dataset = { data: counts, backgroundColor: colors, borderWidth: 1, borderColor: "#0f172a" };

  if (hourChart) {
    hourChart.data.labels = labels;
    hourChart.data.datasets = [dataset];
    hourChart.update();
  } else {
    hourChart = new Chart($<HTMLCanvasElement>("hour-chart").getContext("2d"), {
      type: "polarArea",
      data: { labels, datasets: [dataset] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          r: {
            grid: { color: "rgba(148,163,184,0.15)" },
            angleLines: { color: "rgba(148,163,184,0.15)" },
            ticks: { color: "rgba(148,163,184,0.7)", backdropColor: "transparent" },
            pointLabels: { display: false }
          }
        },
        plugins: { legend: { display: false } }
      }
    });
  }
}

// --- chart 9: palate radar (total alcohol grams by type) -----------------

let palateChart: ChartInstance | null = null;

function renderPalateRadar(range: RangeKey): void {
  const grams = new Map<DrinkType, number>();
  for (const e of filterByRange(range)) {
    const t = categorizeDrink(e.label, e.abv);
    grams.set(t, (grams.get(t) ?? 0) + e.gramsAlcohol);
  }
  const labels = DRINK_TYPES;
  const data = labels.map((t) => Number((grams.get(t) ?? 0).toFixed(1)));

  const dataset = {
    label: "Alcohol (g)",
    data,
    backgroundColor: "rgba(124, 77, 255, 0.25)",
    borderColor: "#7c4dff",
    borderWidth: 2,
    pointBackgroundColor: labels.map((t) => TYPE_COLORS[t]),
    pointRadius: 4
  };

  if (palateChart) {
    palateChart.data.datasets = [dataset];
    palateChart.update();
  } else {
    palateChart = new Chart($<HTMLCanvasElement>("palate-chart").getContext("2d"), {
      type: "radar",
      data: { labels, datasets: [dataset] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          r: {
            grid: { color: "rgba(148,163,184,0.15)" },
            angleLines: { color: "rgba(148,163,184,0.15)" },
            ticks: { color: "rgba(148,163,184,0.7)", backdropColor: "transparent" },
            pointLabels: { color: "rgba(148,163,184,0.9)", font: { size: 12 } }
          }
        },
        plugins: { legend: { display: false } }
      }
    });
  }
}

// --- chart 10: cumulative alcohol over time (running total) --------------

let cumulativeChart: ChartInstance | null = null;
const cumulativeSpanRef = { value: 7 * 24 * 3_600_000 };

function renderCumulative(range: RangeKey): void {
  const data = filterByRange(range).sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  let running = 0;
  const points = data.map((e) => {
    running += e.gramsAlcohol;
    return { x: new Date(e.timestamp).getTime(), y: Number(running.toFixed(1)) };
  });
  if (points.length > 0) {
    cumulativeSpanRef.value = points[points.length - 1].x - points[0].x || 24 * 3_600_000;
  }

  const dataset = {
    label: "Cumulative alcohol (g)",
    data: points,
    borderColor: "#10b981",
    backgroundColor: "rgba(16, 185, 129, 0.15)",
    borderWidth: 2,
    fill: true,
    stepped: false,
    tension: 0,
    pointRadius: 0
  };

  if (cumulativeChart) {
    cumulativeChart.data.datasets = [dataset];
    cumulativeChart.update();
  } else {
    cumulativeChart = new Chart($<HTMLCanvasElement>("cumulative-chart").getContext("2d"), {
      type: "line",
      data: { datasets: [dataset] },
      options: lineChartOptions(cumulativeSpanRef, "Alcohol (g)")
    });
  }
}

// --- chart 11: peak BAC vs drinks per night (bubble) ---------------------

let bubbleChart: ChartInstance | null = null;

function renderPeakVsDrinks(range: RangeKey): void {
  const groups = groupByNight(filterByRange(range), profile.dayStartHour);
  const points = groups.map((g) => {
    const totalG = g.entries.reduce((s, e) => s + e.gramsAlcohol, 0);
    return {
      x: g.entries.length,
      y: Number(peakBacForEntries(g.entries, profile).toFixed(4)),
      r: Math.max(4, Math.sqrt(totalG) * 1.6), // bubble area ∝ total alcohol
      night: new Date(`${g.key}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" })
    };
  });

  const dataset = {
    label: "Night",
    data: points,
    backgroundColor: "rgba(245, 158, 11, 0.5)",
    borderColor: "#f59e0b",
    borderWidth: 1
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: {
        beginAtZero: true,
        title: { display: true, text: "Drinks that night", color: "rgba(148,163,184,0.9)" },
        grid: { color: "rgba(148,163,184,0.15)" },
        ticks: { color: "rgba(148,163,184,0.9)", precision: 0 }
      },
      y: {
        beginAtZero: true,
        title: { display: true, text: "Peak BAC %", color: "rgba(148,163,184,0.9)" },
        grid: { color: "rgba(148,163,184,0.15)" },
        ticks: { color: "rgba(148,163,184,0.9)" }
      }
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx: { raw: { x: number; y: number; night: string } }) =>
            `${ctx.raw.night}: ${ctx.raw.x} drinks, peak ${ctx.raw.y.toFixed(3)}%`
        }
      }
    }
  };

  if (bubbleChart) {
    bubbleChart.data.datasets = [dataset];
    bubbleChart.update();
  } else {
    bubbleChart = new Chart($<HTMLCanvasElement>("bubble-chart").getContext("2d"), {
      type: "bubble",
      data: { datasets: [dataset] },
      options
    });
  }
}

// --- full entry history (one night per page) -----------------------------

// Page index into the nights array, newest night = page 0.
let entryPage = 0;

function renderEntriesList(): void {
  const list = $("entries-list");
  const count = $("entries-count");
  const pager = $("entries-pager");
  list.innerHTML = "";

  if (entries.length === 0) {
    list.innerHTML = `<li class="text-slate-500 text-sm">No entries yet.</li>`;
    count.textContent = "";
    pager.classList.add("hidden");
    return;
  }

  // Newest night first.
  const nights = groupByNight(entries, profile.dayStartHour).reverse();

  // Clamp the page in case entries changed (e.g. a night was emptied by delete).
  entryPage = Math.min(Math.max(0, entryPage), nights.length - 1);
  const night = nights[entryPage];

  count.textContent = `${entries.length} total · ${nights.length} night${nights.length === 1 ? "" : "s"}`;

  const nightDate = new Date(`${night.key}T12:00:00`).toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric"
  });
  const header = document.createElement("li");
  header.className = "mb-1 text-xs uppercase tracking-wide text-slate-500";
  header.textContent = `${nightDate} · ${night.entries.length} drink${night.entries.length === 1 ? "" : "s"}`;
  list.appendChild(header);

  const sorted = [...night.entries].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  for (const e of sorted) {
    const li = document.createElement("li");
    li.className = "flex items-center gap-3 py-2 border-b border-slate-800";
    const time = new Date(e.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
    const name = e.label ?? `${Math.round(e.volumeMl)} mL @ ${e.abv}%`;

    const del = document.createElement("button");
    del.className = "text-slate-500 hover:text-red-400 text-sm shrink-0";
    del.title = "Delete this entry";
    del.textContent = "🗑";
    del.addEventListener("click", () => removeHistoryEntry(e.id));

    const label = document.createElement("span");
    label.className = "text-sm text-slate-200 flex-1";
    label.textContent = name;

    const meta = document.createElement("span");
    meta.className = "text-xs text-slate-500 shrink-0";
    meta.textContent = `${e.gramsAlcohol.toFixed(1)} g · ${time}`;

    li.append(del, label, meta);
    list.appendChild(li);
  }

  // Pager: "Newer" moves toward page 0 (recent), "Older" toward the last page.
  pager.classList.toggle("hidden", nights.length <= 1);
  $("entries-page-label").textContent = `Night ${entryPage + 1} of ${nights.length}`;
  ($("entries-prev") as HTMLButtonElement).disabled = entryPage === 0;
  ($("entries-next") as HTMLButtonElement).disabled = entryPage >= nights.length - 1;
}

function changeEntryPage(delta: number): void {
  entryPage += delta;
  renderEntriesList();
}

async function removeHistoryEntry(id: string): Promise<void> {
  try {
    const res = await deleteEntry(id);
    entries = res.entries;
    rerenderAll();
  } catch {
    // ignore; the list will simply stay as-is
  }
}

// --- wiring --------------------------------------------------------------

// Track each chart's current range so a delete can re-render everything in place.
const current = {
  bac: "week" as RangeKey,
  drinks: "week" as RangeKey,
  peak: "week" as RangeKey,
  grams: "week" as RangeKey,
  dow: "all" as RangeKey,
  type: "week" as RangeKey,
  typenight: "week" as RangeKey,
  hour: "all" as RangeKey,
  palate: "all" as RangeKey,
  cumulative: "all" as RangeKey,
  bubble: "all" as RangeKey
};

function rerenderAll(): void {
  renderBacOverTime(current.bac);
  renderDrinksPerNight(current.drinks);
  renderPeakBac(current.peak);
  renderGramsPerNight(current.grams);
  renderByDayOfWeek(current.dow);
  renderDrinksByType(current.type);
  renderGramsByTypePerNight(current.typenight);
  renderDrinkingClock(current.hour);
  renderPalateRadar(current.palate);
  renderCumulative(current.cumulative);
  renderPeakVsDrinks(current.bubble);
  renderNightDetail();
  renderEntriesList();
}

async function init(): Promise<void> {
  try {
    [profile, entries] = await Promise.all([fetchProfile(), fetchEntries()]);
  } catch {
    // Leave defaults; charts will simply be empty.
  }

  // Each control updates its stored range then re-renders its own chart.
  const bind = (id: string, key: keyof typeof current, fn: (r: RangeKey) => void) =>
    buildRangeControls($(`range-${id}`), current[key], (r) => {
      current[key] = r;
      fn(r);
    });

  bind("bac", "bac", renderBacOverTime);
  bind("drinks", "drinks", renderDrinksPerNight);
  bind("peak", "peak", renderPeakBac);
  bind("grams", "grams", renderGramsPerNight);
  bind("dow", "dow", renderByDayOfWeek);
  bind("type", "type", renderDrinksByType);
  bind("typenight", "typenight", renderGramsByTypePerNight);
  bind("hour", "hour", renderDrinkingClock);
  bind("palate", "palate", renderPalateRadar);
  bind("cumulative", "cumulative", renderCumulative);
  bind("bubble", "bubble", renderPeakVsDrinks);

  $("entries-prev").addEventListener("click", () => changeEntryPage(-1));
  $("entries-next").addEventListener("click", () => changeEntryPage(1));

  $("night-prev").addEventListener("click", () => changeNight(-1));
  $("night-next").addEventListener("click", () => changeNight(1));

  setupChartExpand();
  rerenderAll();
}

// --- enlarge charts ------------------------------------------------------

// Every chart's canvas id; the wrapper div is its parent, the range control is
// "range-<name>" (name = id without the "-chart" suffix).
const CHART_CANVAS_IDS = [
  "bac-chart",
  "drinks-chart",
  "peak-chart",
  "grams-chart",
  "dow-chart",
  "type-chart",
  "typenight-chart",
  "hour-chart",
  "palate-chart",
  "cumulative-chart",
  "bubble-chart"
];

/**
 * Adds an "enlarge" button to each chart. Clicking it moves the chart's canvas
 * wrapper into a modal (so Chart.js resizes it up, keeping all interactivity);
 * closing moves it back to its original spot.
 */
function setupChartExpand(): void {
  const modal = $("chart-modal");
  const body = $("chart-modal-body");
  const titleEl = $("chart-modal-title");

  // Where the currently-enlarged chart came from, so we can restore it exactly.
  let active: {
    wrapper: HTMLElement;
    parent: HTMLElement;
    next: Node | null;
    cls: string;
  } | null = null;

  const forceResize = () => window.dispatchEvent(new Event("resize"));

  const close = (): void => {
    if (!active) return;
    active.wrapper.className = active.cls;
    active.parent.insertBefore(active.wrapper, active.next);
    modal.classList.add("hidden");
    active = null;
    requestAnimationFrame(forceResize);
  };

  const open = (wrapper: HTMLElement, title: string): void => {
    if (active) close();
    active = {
      wrapper,
      parent: wrapper.parentElement as HTMLElement,
      next: wrapper.nextSibling,
      cls: wrapper.className
    };
    wrapper.className = "w-full h-full";
    titleEl.textContent = title;
    body.appendChild(wrapper);
    modal.classList.remove("hidden");
    requestAnimationFrame(forceResize);
  };

  for (const canvasId of CHART_CANVAS_IDS) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !canvas.parentElement) continue;
    const wrapper = canvas.parentElement;

    const name = canvasId.replace("-chart", "");
    const rangeDiv = document.getElementById(`range-${name}`);
    if (!rangeDiv || !rangeDiv.parentElement) continue;
    const header = rangeDiv.parentElement; // the flex justify-between header row
    const chartTitle = header.querySelector("h2")?.textContent ?? "Chart";

    // Group the range control and a new expand button together on the right.
    const group = document.createElement("div");
    group.className = "flex items-center gap-2";
    header.insertBefore(group, rangeDiv);
    group.appendChild(rangeDiv);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = "Enlarge";
    btn.textContent = "⤢";
    btn.className = "px-2 py-1 text-sm rounded-md bg-slate-700 text-slate-300 hover:bg-slate-600";
    btn.addEventListener("click", () => open(wrapper, chartTitle));
    group.appendChild(btn);
  }

  $("chart-modal-close").addEventListener("click", close);
  // Click on the backdrop (outside the panel) closes.
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
}

init();
