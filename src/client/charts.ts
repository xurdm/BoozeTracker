// Chart.js helpers. Chart.js is loaded as a UMD global via <script>, so we
// read it off `window` as a real value export (a `declare const` would be
// erased at compile time and break the re-export below).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Chart: any = (window as unknown as { Chart: unknown }).Chart;

export type RangeKey = "day" | "week" | "month" | "all";

export const RANGE_LABELS: Record<RangeKey, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  all: "All"
};

/** Milliseconds covered by a range, or null for "all". */
export function rangeMs(range: RangeKey): number | null {
  switch (range) {
    case "day":
      return 24 * 3_600_000;
    case "week":
      return 7 * 24 * 3_600_000;
    case "month":
      return 30 * 24 * 3_600_000;
    case "all":
      return null;
  }
}

/** Format an epoch-ms tick adaptively based on the visible span. */
export function formatTimeTick(ms: number, spanMs: number): string {
  const d = new Date(ms);
  if (spanMs <= 2 * 24 * 3_600_000) {
    // Within ~2 days: show clock time.
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  // Longer spans: show month/day.
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Build a row of Day/Week/Month/All buttons; calls onChange with the key. */
export function buildRangeControls(
  container: HTMLElement,
  initial: RangeKey,
  onChange: (range: RangeKey) => void
): void {
  container.innerHTML = "";
  const keys: RangeKey[] = ["day", "week", "month", "all"];
  let active = initial;

  const render = () => {
    container.querySelectorAll("button").forEach((btn) => {
      const key = btn.dataset.range as RangeKey;
      const isActive = key === active;
      btn.className = isActive
        ? "px-3 py-1 text-sm rounded-md bg-booze-500 text-white font-medium"
        : "px-3 py-1 text-sm rounded-md bg-slate-700 text-slate-300 hover:bg-slate-600";
    });
  };

  for (const key of keys) {
    const btn = document.createElement("button");
    btn.dataset.range = key;
    btn.textContent = RANGE_LABELS[key];
    btn.addEventListener("click", () => {
      active = key;
      render();
      onChange(key);
    });
    container.appendChild(btn);
  }
  render();
}

const GRID_COLOR = "rgba(148, 163, 184, 0.15)";
const TICK_COLOR = "rgba(148, 163, 184, 0.9)";

/** Shared options for a linear time-axis line chart. */
export function lineChartOptions(spanMsRef: { value: number }, yLabel: string) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    scales: {
      x: {
        type: "linear",
        grid: { color: GRID_COLOR },
        ticks: {
          color: TICK_COLOR,
          maxTicksLimit: 8,
          callback: (v: number) => formatTimeTick(Number(v), spanMsRef.value)
        }
      },
      y: {
        beginAtZero: true,
        grid: { color: GRID_COLOR },
        ticks: { color: TICK_COLOR },
        title: { display: true, text: yLabel, color: TICK_COLOR }
      }
    },
    plugins: {
      legend: { labels: { color: TICK_COLOR } },
      tooltip: {
        callbacks: {
          title: (items: Array<{ parsed: { x: number } }>) =>
            items.length ? new Date(items[0].parsed.x).toLocaleString() : ""
        }
      }
    }
  };
}

/** Shared options for a categorical bar chart (e.g. per-night metrics). */
export function barChartOptions(yLabel: string) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: { grid: { color: GRID_COLOR }, ticks: { color: TICK_COLOR } },
      y: {
        beginAtZero: true,
        grid: { color: GRID_COLOR },
        ticks: { color: TICK_COLOR },
        title: { display: true, text: yLabel, color: TICK_COLOR }
      }
    },
    plugins: { legend: { labels: { color: TICK_COLOR } } }
  };
}
