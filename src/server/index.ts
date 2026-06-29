// Tiny Express server: serves static assets and exposes a minimal JSON API
// for the single profile and the flat list of entries. No business logic here
// beyond validation — BAC math lives in src/shared/bac.ts and runs in the
// browser.

import express from "express";
import * as path from "path";
import { randomUUID } from "crypto";
import { gramsOfAlcohol } from "../shared/bac";
import type { Entry, Profile, Sex, Units } from "../shared/types";
import {
  addEntry,
  deleteEntry,
  getEntries,
  getProfile,
  saveProfile
} from "./storage";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// --- Profile -------------------------------------------------------------

app.get("/api/profile", async (_req, res) => {
  res.json(await getProfile());
});

app.put("/api/profile", async (req, res) => {
  const body = req.body ?? {};
  const current = await getProfile();

  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;

  const sex: Sex = body.sex === "female" ? "female" : "male";
  const units: Units = body.units === "metric" ? "metric" : "imperial";

  const next: Profile = {
    weightKg: Math.max(1, num(body.weightKg, current.weightKg)),
    sex,
    units,
    betaRate: Math.max(0.001, num(body.betaRate, current.betaRate)),
    absorptionMinutes: Math.max(0, num(body.absorptionMinutes, current.absorptionMinutes)),
    dayStartHour: Math.min(23, Math.max(0, Math.round(num(body.dayStartHour, current.dayStartHour))))
  };

  if (typeof body.rOverride === "number" && Number.isFinite(body.rOverride) && body.rOverride > 0) {
    next.rOverride = body.rOverride;
  }

  res.json(await saveProfile(next));
});

// --- Entries -------------------------------------------------------------

app.get("/api/entries", async (_req, res) => {
  res.json(await getEntries());
});

app.post("/api/entries", async (req, res) => {
  const body = req.body ?? {};
  const volumeMl = Number(body.volumeMl);
  const abv = Number(body.abv);

  if (!Number.isFinite(volumeMl) || volumeMl <= 0 || !Number.isFinite(abv) || abv < 0) {
    res.status(400).json({ error: "volumeMl must be > 0 and abv must be >= 0" });
    return;
  }

  const timestamp =
    typeof body.timestamp === "string" && !Number.isNaN(Date.parse(body.timestamp))
      ? new Date(body.timestamp).toISOString()
      : new Date().toISOString();

  const entry: Entry = {
    id: randomUUID(),
    timestamp,
    volumeMl,
    abv,
    label: typeof body.label === "string" ? body.label : undefined,
    gramsAlcohol: gramsOfAlcohol(volumeMl, abv)
  };

  const entries = await addEntry(entry);
  res.status(201).json({ entry, entries });
});

app.delete("/api/entries/:id", async (req, res) => {
  const entries = await deleteEntry(req.params.id);
  res.json({ entries });
});

app.listen(PORT, () => {
  console.log(`BoozeTracker running at http://localhost:${PORT}`);
});
