# 🍺 BoozeTracker

A small, single-user web app for tracking alcohol consumption — built for fast
nightly logging, live BAC estimation, and historical reporting.

- **One-tap logging.** Tap a drink preset (or pick a volume + ABV combo) to log
  instantly. No text boxes.
- **Live BAC chart.** A continuous curve shows your BAC so far (solid) and the
  projected decline to zero (dashed), with a "Sober at ~HH:MM" headline.
- **History page.** BAC over time, drinks per night, peak BAC per night, total
  alcohol per night (with a 7-night rolling average), and average drinks by day
  of week — each with Day / Week / Month / All range controls.
- **Single profile**, auto-loaded and auto-saved, stored in SQLite.

> ⚠️ **Disclaimer:** BAC values are approximations from the Widmark formula using
> population averages. Individual results vary widely. **Never use this app to
> decide whether it is safe to drive.**

## Tech

- **Node.js + TypeScript**, compiled with `tsc` only (no bundler).
- **Express** serves static assets and a tiny JSON API.
- **Chart.js** is vendored as a UMD file and loaded via `<script>`.
- **Tailwind CSS** is generated via its CLI.
- BAC math lives in `src/shared/bac.ts` and runs in the browser; the server is
  a dumb data store backed by SQLite (`node:sqlite`, no native dependency).

## Setup

```bash
npm install
npm run build
npm start
```

Then open http://localhost:3000 (set `PORT` to change).

`npm run build` does four things: copies Chart.js into `public/vendor/`,
generates `public/styles.css`, and compiles the server (→ `dist/`) and client
(→ `public/js/`).

## Development

There is no `concurrently` dependency, so run the three watchers in separate
terminals:

```bash
npm run dev:css      # Tailwind --watch
npm run dev:client   # tsc --watch  -> public/js
npm run dev:server   # tsx watch    -> live server
```

(Run `npm run copy:vendor` once first so `public/vendor/chart.umd.js` exists.)

## Tests

```bash
npm test
```

Unit tests (Vitest) cover the BAC math and nightly-grouping logic in
`src/shared/bac.ts`.

## Data

Data is stored in a SQLite database via Node's built-in `node:sqlite` module
(no native dependency, so it works identically under plain Node, PM2, and
Electron). Two tables: `entries` (one row per drink) and `profile` (a single
row).

- **Plain Node / PM2:** the database lives at `data/boozetracker.db` (gitignored).
- **Packaged Electron app:** it lives in the OS `userData` dir
  (`%APPDATA%/BoozeTracker/data/` on Windows), set via `BOOZETRACKER_DATA_DIR`.

On first open, if legacy `entries.json` / `profile.json` files exist alongside
the database, their contents are imported once (existing JSON data is
preserved). Those files are then no longer read.

## BAC model

Widmark equation with linear absorption and elimination:

- Grams of ethanol per drink: `volumeMl × (abv/100) × 0.789`.
- Peak contribution: `grams / (weightGrams × r) × 100`.
- `r` defaults to 0.68 (male) / 0.55 (female), overridable in settings.
- Each drink absorbs linearly over `absorptionMinutes` (default 30).
- BAC declines at `betaRate` %/hr (default 0.015).
- A "night" begins at `dayStartHour` local time (default 4 AM), so a 2 AM drink
  counts toward the previous night.

All parameters are editable in the on-page settings panel.
