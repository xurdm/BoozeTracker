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
  typenight: "week" as RangeKey
};

function rerenderAll(): void {
  renderBacOverTime(current.bac);
  renderDrinksPerNight(current.drinks);
  renderPeakBac(current.peak);
  renderGramsPerNight(current.grams);
  renderByDayOfWeek(current.dow);
  renderDrinksByType(current.type);
  renderGramsByTypePerNight(current.typenight);
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

  $("entries-prev").addEventListener("click", () => changeEntryPage(-1));
  $("entries-next").addEventListener("click", () => changeEntryPage(1));

  rerenderAll();
}

init();
