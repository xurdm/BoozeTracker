// SQLite persistence for the profile and entries, using Node's built-in
// `node:sqlite` module (no native dependency, so it works identically under
// plain Node, PM2, and Electron). The public API is unchanged and still async
// so callers don't need to change, even though the driver is synchronous.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "fs";
import * as path from "path";
import { DEFAULT_PROFILE, type Entry, type Profile } from "../shared/types";

// Resolved lazily so the Electron shell can point BOOZETRACKER_DATA_DIR at a
// writable location (userData) — the bundled asar is read-only. Falls back to
// the project's data/ folder for `npm start` / PM2.
function dataDir(): string {
  return process.env.BOOZETRACKER_DATA_DIR || path.join(__dirname, "..", "..", "data");
}
function dbFile(): string {
  return path.join(dataDir(), "boozetracker.db");
}

let db: DatabaseSync | null = null;
let openedPath: string | null = null;

/** Open (once) and return the database, creating the schema on first use. */
function getDb(): DatabaseSync {
  const file = dbFile();
  if (db && openedPath === file) return db;

  const dir = dataDir();
  mkdirSync(dir, { recursive: true });

  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id           TEXT PRIMARY KEY,
      timestamp    TEXT NOT NULL,
      volumeMl     REAL NOT NULL,
      abv          REAL NOT NULL,
      label        TEXT,
      gramsAlcohol REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entries_timestamp ON entries(timestamp);
    CREATE TABLE IF NOT EXISTS profile (
      id                INTEGER PRIMARY KEY CHECK (id = 1),
      weightKg          REAL,
      sex               TEXT,
      units             TEXT,
      rOverride         REAL,
      betaRate          REAL,
      absorptionMinutes REAL,
      dayStartHour      INTEGER
    );
  `);

  migrateFromJson(db, dir);
  openedPath = file;
  return db;
}

/**
 * One-time import of legacy JSON files (entries.json / profile.json) if they
 * exist and the corresponding table is still empty. Preserves data logged
 * before the switch to SQLite; safe to run on every open.
 */
function migrateFromJson(database: DatabaseSync, dir: string): void {
  const entryCount = (
    database.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }
  ).n;
  if (entryCount === 0) {
    const file = path.join(dir, "entries.json");
    if (existsSync(file)) {
      try {
        const rows = JSON.parse(readFileSync(file, "utf8")) as Entry[];
        const insert = database.prepare(
          `INSERT OR IGNORE INTO entries (id, timestamp, volumeMl, abv, label, gramsAlcohol)
           VALUES (?, ?, ?, ?, ?, ?)`
        );
        for (const e of rows) {
          insert.run(e.id, e.timestamp, e.volumeMl, e.abv, e.label ?? null, e.gramsAlcohol);
        }
      } catch {
        // Corrupt/partial legacy file — skip rather than block startup.
      }
    }
  }

  const hasProfile = database.prepare("SELECT 1 FROM profile WHERE id = 1").get();
  if (!hasProfile) {
    const file = path.join(dir, "profile.json");
    if (existsSync(file)) {
      try {
        const p = { ...DEFAULT_PROFILE, ...JSON.parse(readFileSync(file, "utf8")) } as Profile;
        writeProfileRow(database, p);
      } catch {
        // Skip a bad legacy profile file; defaults will be used.
      }
    }
  }
}

function writeProfileRow(database: DatabaseSync, p: Profile): void {
  database
    .prepare(
      `INSERT INTO profile (id, weightKg, sex, units, rOverride, betaRate, absorptionMinutes, dayStartHour)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         weightKg = excluded.weightKg,
         sex = excluded.sex,
         units = excluded.units,
         rOverride = excluded.rOverride,
         betaRate = excluded.betaRate,
         absorptionMinutes = excluded.absorptionMinutes,
         dayStartHour = excluded.dayStartHour`
    )
    .run(
      p.weightKg,
      p.sex,
      p.units,
      p.rOverride ?? null,
      p.betaRate,
      p.absorptionMinutes,
      p.dayStartHour
    );
}

interface EntryRow {
  id: string;
  timestamp: string;
  volumeMl: number;
  abv: number;
  label: string | null;
  gramsAlcohol: number;
}

function rowToEntry(r: EntryRow): Entry {
  const entry: Entry = {
    id: r.id,
    timestamp: r.timestamp,
    volumeMl: r.volumeMl,
    abv: r.abv,
    gramsAlcohol: r.gramsAlcohol
  };
  if (r.label != null) entry.label = r.label;
  return entry;
}

// --- Profile -------------------------------------------------------------

export async function getProfile(): Promise<Profile> {
  const row = getDb().prepare("SELECT * FROM profile WHERE id = 1").get() as
    | (Profile & { id: number; rOverride: number | null })
    | undefined;
  if (!row) return { ...DEFAULT_PROFILE };
  const { id: _id, rOverride, ...rest } = row;
  void _id;
  const profile: Profile = { ...DEFAULT_PROFILE, ...rest };
  if (rOverride != null) profile.rOverride = rOverride;
  else delete profile.rOverride;
  return profile;
}

export async function saveProfile(profile: Profile): Promise<Profile> {
  const merged: Profile = { ...DEFAULT_PROFILE, ...profile };
  writeProfileRow(getDb(), merged);
  return merged;
}

// --- Entries -------------------------------------------------------------

export async function getEntries(): Promise<Entry[]> {
  const rows = getDb()
    .prepare("SELECT * FROM entries ORDER BY timestamp ASC")
    .all() as unknown as EntryRow[];
  return rows.map(rowToEntry);
}

export async function saveEntries(entries: Entry[]): Promise<void> {
  const database = getDb();
  database.exec("BEGIN");
  try {
    database.exec("DELETE FROM entries");
    const insert = database.prepare(
      `INSERT INTO entries (id, timestamp, volumeMl, abv, label, gramsAlcohol)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const e of entries) {
      insert.run(e.id, e.timestamp, e.volumeMl, e.abv, e.label ?? null, e.gramsAlcohol);
    }
    database.exec("COMMIT");
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
}

export async function addEntry(entry: Entry): Promise<Entry[]> {
  getDb()
    .prepare(
      `INSERT INTO entries (id, timestamp, volumeMl, abv, label, gramsAlcohol)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.id,
      entry.timestamp,
      entry.volumeMl,
      entry.abv,
      entry.label ?? null,
      entry.gramsAlcohol
    );
  return getEntries();
}

export async function deleteEntry(id: string): Promise<Entry[]> {
  getDb().prepare("DELETE FROM entries WHERE id = ?").run(id);
  return getEntries();
}
