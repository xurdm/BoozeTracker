// Main page: one-tap entry logging, live BAC chart, and the settings panel.

import { addEntry, deleteEntry, fetchEntries, fetchProfile, updateProfile } from "./api.js";
import { Chart, lineChartOptions } from "./charts.js";
import {
  bacSummary,
  sampleBacCurve,
  totalBacAt
} from "../shared/bac.js";
import { ABV_PRESETS, DRINK_PRESETS, ML_PER_OZ, VOLUME_PRESETS } from "../shared/presets.js";
import { DEFAULT_PROFILE, type Entry, type Profile } from "../shared/types.js";

let profile: Profile = { ...DEFAULT_PROFILE };
let entries: Entry[] = [];
let liveChart: ChartInstance | null = null;
const spanRef = { value: 24 * 3_600_000 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChartInstance = any;

// --- helpers -------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

function mlToOz(ml: number): number {
  return ml / ML_PER_OZ;
}

function formatVolume(ml: number): string {
  if (profile.units === "metric") return `${Math.round(ml)} mL`;
  return `${(Math.round(mlToOz(ml) * 10) / 10).toString()} oz`;
}

function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

// Compact "how long ago" label, e.g. "just now", "10m ago", "1h ago", "2d ago".
function formatRelative(timestamp: string, nowMs: number): string {
  const diffMs = nowMs - new Date(timestamp).getTime();
  if (diffMs < 60_000) return "just now";
  const min = Math.floor(diffMs / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function toast(msg: string): void {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("opacity-0");
  el.classList.add("opacity-100");
  window.setTimeout(() => {
    el.classList.remove("opacity-100");
    el.classList.add("opacity-0");
  }, 1800);
}

// --- entry logging -------------------------------------------------------

// How far back to backdate the next logged drink, in minutes (0 = now).
let selectedOffsetMinutes = 0;

const TIME_PRESETS: Array<{ label: string; minutes: number }> = [
  { label: "Now", minutes: 0 },
  { label: "15m ago", minutes: 15 },
  { label: "30m ago", minutes: 30 },
  { label: "1h ago", minutes: 60 },
  { label: "2h ago", minutes: 120 },
  { label: "3h ago", minutes: 180 },
  { label: "4h ago", minutes: 240 }
];

async function logDrink(volumeMl: number, abv: number, label: string): Promise<void> {
  const offset = selectedOffsetMinutes;
  const timestamp =
    offset > 0 ? new Date(Date.now() - offset * 60_000).toISOString() : undefined;
  try {
    const res = await addEntry({ volumeMl, abv, label, timestamp });
    entries = res.entries;
    const when =
      offset > 0
        ? ` at ${new Date(Date.now() - offset * 60_000).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit"
          })}`
        : "";
    toast(`Logged ${label}${when}`);
    // Reset to "Now" so a backdate doesn't silently carry to the next drink.
    selectedOffsetMinutes = 0;
    renderTimeChips();
    refresh();
  } catch (err) {
    toast(`Failed to log: ${(err as Error).message}`);
  }
}

function renderTimeChips(): void {
  const row = $("time-chips");
  row.innerHTML = "";
  for (const t of TIME_PRESETS) {
    const chip = document.createElement("button");
    chip.textContent = t.label;
    chip.className =
      selectedOffsetMinutes === t.minutes
        ? "px-3 py-2 rounded-full bg-booze-500 text-white text-sm font-medium"
        : "px-3 py-2 rounded-full bg-slate-700 text-slate-200 text-sm hover:bg-slate-600";
    chip.addEventListener("click", () => {
      selectedOffsetMinutes = t.minutes;
      renderTimeChips();
    });
    row.appendChild(chip);
  }
}

async function undoLast(): Promise<void> {
  if (entries.length === 0) {
    toast("Nothing to undo");
    return;
  }
  const last = entries.reduce((a, b) => (a.timestamp >= b.timestamp ? a : b));
  try {
    const res = await deleteEntry(last.id);
    entries = res.entries;
    toast(`Removed ${last.label ?? "last drink"}`);
    refresh();
  } catch (err) {
    toast(`Failed to undo: ${(err as Error).message}`);
  }
}

// --- preset UI -----------------------------------------------------------

function renderDrinkPresets(): void {
  const grid = $("drink-presets");
  grid.innerHTML = "";
  for (const p of DRINK_PRESETS) {
    const card = document.createElement("button");
    card.className =
      "flex flex-col items-center justify-center gap-1 rounded-xl bg-slate-800 hover:bg-booze-600 active:scale-95 transition p-4 text-center shadow";
    card.innerHTML = `
      <span class="text-3xl">${p.icon}</span>
      <span class="text-sm font-medium text-slate-100">${p.label}</span>`;
    card.addEventListener("click", () => logDrink(p.ml, p.abv, p.label));
    grid.appendChild(card);
  }
}

// Custom combo: pick a volume chip and an ABV chip, then Add.
let selectedVolume: number | null = null;
let selectedAbv: number | null = null;

function renderComboChips(): void {
  const volRow = $("volume-chips");
  const abvRow = $("abv-chips");
  volRow.innerHTML = "";
  abvRow.innerHTML = "";

  const chipClass = (active: boolean) =>
    active
      ? "px-3 py-2 rounded-full bg-booze-500 text-white text-sm font-medium"
      : "px-3 py-2 rounded-full bg-slate-700 text-slate-200 text-sm hover:bg-slate-600";

  const updateAddState = () => {
    const btn = $<HTMLButtonElement>("combo-add");
    btn.disabled = selectedVolume === null || selectedAbv === null;
    btn.className = btn.disabled
      ? "px-4 py-2 rounded-lg bg-slate-700 text-slate-500 cursor-not-allowed text-sm font-medium"
      : "px-4 py-2 rounded-lg bg-booze-500 hover:bg-booze-600 text-white text-sm font-medium";
  };

  for (const v of VOLUME_PRESETS) {
    const chip = document.createElement("button");
    chip.textContent = profile.units === "metric" ? `${Math.round(v.ml)} mL` : v.label;
    chip.className = chipClass(selectedVolume === v.ml);
    chip.addEventListener("click", () => {
      selectedVolume = v.ml;
      renderComboChips();
    });
    volRow.appendChild(chip);
  }

  for (const a of ABV_PRESETS) {
    const chip = document.createElement("button");
    chip.textContent = a.label;
    chip.className = chipClass(selectedAbv === a.abv);
    chip.addEventListener("click", () => {
      selectedAbv = a.abv;
      renderComboChips();
    });
    abvRow.appendChild(chip);
  }

  updateAddState();
}

// --- live chart ----------------------------------------------------------

function buildLiveChart(): void {
  const ctx = $<HTMLCanvasElement>("live-chart").getContext("2d");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const options: any = lineChartOptions(spanRef, "BAC %");
  // Hide points on the line datasets, but let the drink-marker dataset set its
  // own radius so the markers still show.
  options.elements = { point: { radius: 0 } };
  // Hover only when the cursor is actually over a marker (the line has no
  // intersectable points since its radius is 0), so markers win regardless of
  // the curve passing through them.
  options.interaction = { mode: "nearest", intersect: true };
  options.plugins.tooltip.mode = "nearest";
  options.plugins.tooltip.intersect = true;
  // On a marker, combine the BAC at that point with the drink name(s) in a
  // single tooltip; on the curve, just the BAC %.
  options.plugins.tooltip.callbacks.label = (ctx2: {
    raw?: { drinks?: string[] };
    parsed: { y: number };
  }) => {
    const bac = `BAC: ${Number(ctx2.parsed.y).toFixed(3)}%`;
    if (ctx2.raw && ctx2.raw.drinks) return [bac, ...ctx2.raw.drinks];
    return bac;
  };
  liveChart = new Chart(ctx, {
    type: "line",
    data: { datasets: [] },
    options
  });
}

interface DrinkMarker {
  x: number;
  y: number;
  drinks: string[];
}

// Group consumed drinks into per-minute markers, aggregating repeats with a
// count (e.g. "Beer 12oz 5% ×2"). Each marker sits on the BAC curve at its time.
function buildDrinkMarkers(startMs: number, nowMs: number): DrinkMarker[] {
  const buckets = new Map<number, Map<string, number>>();
  for (const e of entries) {
    const t = new Date(e.timestamp).getTime();
    if (t < startMs || t > nowMs) continue;
    const bucket = Math.round(t / 60_000) * 60_000;
    const labels = buckets.get(bucket) ?? new Map<string, number>();
    const name = e.label ?? `${formatVolume(e.volumeMl)} @ ${e.abv}%`;
    labels.set(name, (labels.get(name) ?? 0) + 1);
    buckets.set(bucket, labels);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, labels]) => ({
      x: bucket,
      y: totalBacAt(entries, profile, bucket),
      drinks: [...labels.entries()].map(([name, n]) => (n > 1 ? `🍹 ${name} ×${n}` : `🍹 ${name}`))
    }));
}

function updateLiveChart(): void {
  if (!liveChart) return;
  const now = Date.now();

  // Window: from first drink today (or 1h ago) to projected sober time.
  const summary = bacSummary(entries, profile, now);
  const recent = entries
    .map((e) => new Date(e.timestamp).getTime())
    .filter((t) => t <= now);
  const firstDrink = recent.length ? Math.min(...recent) : now - 3_600_000;
  const start = Math.min(firstDrink, now - 3_600_000);
  const end = summary.soberAtMs ?? now + 3_600_000;
  spanRef.value = end - start;

  const step = Math.max(60_000, Math.round((end - start) / 240));
  const past = sampleBacCurve(entries, profile, start, now, step).map((p) => ({ x: p.t, y: p.bac }));
  const future = sampleBacCurve(entries, profile, now, end, step).map((p) => ({ x: p.t, y: p.bac }));

  liveChart.data.datasets = [
    {
      label: "BAC (so far)",
      data: past,
      borderColor: "#7c4dff",
      backgroundColor: "rgba(124, 77, 255, 0.15)",
      borderWidth: 2,
      fill: true,
      tension: 0.25
    },
    {
      label: "Projected",
      data: future,
      borderColor: "#9d7bff",
      borderDash: [6, 4],
      borderWidth: 2,
      fill: false,
      tension: 0.25
    },
    {
      label: "Drinks",
      type: "scatter",
      data: buildDrinkMarkers(start, now),
      backgroundColor: "#f59e0b",
      borderColor: "#1e293b",
      borderWidth: 2,
      pointRadius: 6,
      pointHoverRadius: 8,
      pointHitRadius: 12,
      showLine: false
    }
  ];

  // "Now" marker via annotation-free approach: a vertical strip dataset.
  liveChart.options.scales.x.min = start;
  liveChart.options.scales.x.max = end;
  liveChart.update("none");

  // Headline.
  const cur = totalBacAt(entries, profile, now);
  $("current-bac").textContent = cur.toFixed(3);
  const headline = $("sober-headline");
  if (summary.soberAtMs && cur > 0) {
    const at = new Date(summary.soberAtMs);
    const clock = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    headline.textContent = `Sober at ~${clock} (in ${formatDuration(summary.msUntilSober)})`;
  } else {
    headline.textContent = "You're sober 🎉";
  }
}

// --- settings panel ------------------------------------------------------

function populateSettings(): void {
  const weightInput = $<HTMLInputElement>("weight-input");
  const weightUnit = $("weight-unit");
  if (profile.units === "metric") {
    weightInput.value = String(Math.round(profile.weightKg));
    weightUnit.textContent = "kg";
  } else {
    weightInput.value = String(Math.round(profile.weightKg / 0.453592));
    weightUnit.textContent = "lb";
  }
  $<HTMLSelectElement>("sex-input").value = profile.sex;
  $<HTMLSelectElement>("units-input").value = profile.units;
  $<HTMLInputElement>("beta-input").value = String(profile.betaRate);
  $<HTMLInputElement>("absorption-input").value = String(profile.absorptionMinutes);
  $<HTMLInputElement>("daystart-input").value = String(profile.dayStartHour);
  $<HTMLInputElement>("roverride-input").value =
    profile.rOverride !== undefined ? String(profile.rOverride) : "";
}

async function saveSettings(): Promise<void> {
  const units = $<HTMLSelectElement>("units-input").value as Profile["units"];
  const weightVal = Number($<HTMLInputElement>("weight-input").value);
  const weightKg = units === "metric" ? weightVal : weightVal * 0.453592;
  const rRaw = $<HTMLInputElement>("roverride-input").value.trim();

  const next: Profile = {
    weightKg: Number.isFinite(weightKg) && weightKg > 0 ? weightKg : profile.weightKg,
    sex: $<HTMLSelectElement>("sex-input").value as Profile["sex"],
    units,
    betaRate: Number($<HTMLInputElement>("beta-input").value) || profile.betaRate,
    absorptionMinutes: Number($<HTMLInputElement>("absorption-input").value),
    dayStartHour: Number($<HTMLInputElement>("daystart-input").value),
    ...(rRaw !== "" && Number(rRaw) > 0 ? { rOverride: Number(rRaw) } : {})
  };

  try {
    profile = await updateProfile(next);
    toast("Settings saved");
    populateSettings();
    renderComboChips();
    refresh();
  } catch (err) {
    toast(`Failed to save: ${(err as Error).message}`);
  }
}

// --- recent list ---------------------------------------------------------

function renderRecent(): void {
  const list = $("recent-list");
  list.innerHTML = "";
  const today = [...entries]
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
    .slice(0, 8);

  if (today.length === 0) {
    list.innerHTML = `<li class="text-slate-500 text-sm">No drinks logged yet.</li>`;
    return;
  }

  for (const e of today) {
    const li = document.createElement("li");
    li.className = "flex items-center justify-between py-2 border-b border-slate-800";
    const time = new Date(e.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
    const ago = formatRelative(e.timestamp, Date.now());
    li.innerHTML = `
      <span class="text-sm text-slate-200">${e.label ?? `${formatVolume(e.volumeMl)} @ ${e.abv}%`}</span>
      <span class="text-xs text-slate-500">${ago} · ${time}</span>`;
    list.appendChild(li);
  }
}

// --- refresh / init ------------------------------------------------------

function refresh(): void {
  updateLiveChart();
  renderRecent();
}

async function init(): Promise<void> {
  // Combo add button.
  $("combo-add").addEventListener("click", () => {
    if (selectedVolume !== null && selectedAbv !== null) {
      const label = `${formatVolume(selectedVolume)} @ ${selectedAbv}%`;
      logDrink(selectedVolume, selectedAbv, label);
    }
  });
  $("undo-btn").addEventListener("click", undoLast);

  // Settings panel toggle + auto-save on change.
  $("settings-toggle").addEventListener("click", () => {
    $("settings-body").classList.toggle("hidden");
  });
  ["weight-input", "sex-input", "units-input", "beta-input", "absorption-input", "daystart-input", "roverride-input"].forEach(
    (id) => $(id).addEventListener("change", saveSettings)
  );

  try {
    [profile, entries] = await Promise.all([fetchProfile(), fetchEntries()]);
  } catch (err) {
    toast(`Failed to load: ${(err as Error).message}`);
  }

  renderTimeChips();
  renderDrinkPresets();
  renderComboChips();
  populateSettings();
  buildLiveChart();
  refresh();

  // Live ticking so the "now" point and headline stay current.
  window.setInterval(refresh, 30_000);
}

init();
