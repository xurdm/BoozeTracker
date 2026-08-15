// SQLite persistence for the profile and entries, using Node's built-in
// `node:sqlite` module (no native dependency, so it works identically under
// plain Node, PM2, and Electron). The public API is unchanged and still async
// so callers don't need to change, even though the driver is synchronous.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "fs";
import * as path from "path";
import * as os from "os";
import { DEFAULT_PROFILE, type Entry, type Profile } from "../shared/types";

/**
 * Per-user application data directory, matching Electron's `userData`
 * convention so the standalone app and `npm start` / PM2 all share one
 * database:
 *   Windows  %APPDATA%/BoozeTracker
 *   macOS    ~/Library/Application Support/BoozeTracker
 *   Linux    $XDG_CONFIG_HOME|~/.config /BoozeTracker
 */
function userDataDir(): string {
  const appName = "BoozeTracker";
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), appName);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", appName);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), appName);
}

// Resolved lazily so the Electron shell can override via BOOZETRACKER_DATA_DIR.
// Both the Electron override and this default resolve to the same shared
// location, so all run modes read/write one database.
function dataDir(): string {
  return process.env.BOOZETRACKER_DATA_DIR || path.join(userDataDir(), "data");
}
function dbFile(): string {
  return path.join(dataDir(), "boozetracker.db");
}

// The old project-local data folder, used only as a one-time migration source
// for histories created before storage moved to the shared user-data location.
function legacyProjectDir(): string {
  return path.join(__dirname, "..", "..", "data");
}
function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
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

  addColumnIfMissing(db, "profile", "nonLiquorOffsetMinutes", "REAL");

  migrateLegacyData(db, dir);
  openedPath = file;
  return db;
}

/** Add a column to an existing table if it isn't already present (simple migration). */
function addColumnIfMissing(
  database: DatabaseSync,
  table: string,
  column: string,
  type: string
): void {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/**
 * One-time seed of a fresh database from legacy sources, so history/profile
 * created before this version (in the project-local `data/` folder, as either
 * a SQLite DB or the original JSON files) carries over to the shared location.
 * Only runs when the target table is empty, so it never overwrites live data.
 */
function migrateLegacyData(database: DatabaseSync, sharedDir: string): void {
  if (countEntries(database) === 0) {
    const entries = readLegacyEntries(sharedDir);
    if (entries.length > 0) {
      const insert = database.prepare(
        `INSERT OR IGNORE INTO entries (id, timestamp, volumeMl, abv, label, gramsAlcohol)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const e of entries) {
        insert.run(e.id, e.timestamp, e.volumeMl, e.abv, e.label ?? null, e.gramsAlcohol);
      }
    }
  }

  if (!database.prepare("SELECT 1 FROM profile WHERE id = 1").get()) {
    const legacyProfile = readLegacyProfile(sharedDir);
    if (legacyProfile) writeProfileRow(database, legacyProfile);
  }
}

function countEntries(database: DatabaseSync): number {
  return (database.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n;
}

/** Candidate source dirs for legacy JSON, in priority order (deduped). */
function legacySourceDirs(sharedDir: string): string[] {
  const dirs = [sharedDir, legacyProjectDir()];
  return dirs.filter((d, i) => dirs.findIndex((o) => samePath(o, d)) === i);
}

/** Read legacy entries from the old project DB first, then any JSON. */
function readLegacyEntries(sharedDir: string): Entry[] {
  const legacyDb = path.join(legacyProjectDir(), "boozetracker.db");
  if (existsSync(legacyDb) && !samePath(legacyDb, dbFile())) {
    const rows = readEntriesFromDb(legacyDb);
    if (rows.length > 0) return rows;
  }
  for (const dir of legacySourceDirs(sharedDir)) {
    const rows = readEntriesFromJson(path.join(dir, "entries.json"));
    if (rows.length > 0) return rows;
  }
  return [];
}

function readLegacyProfile(sharedDir: string): Profile | null {
  const legacyDb = path.join(legacyProjectDir(), "boozetracker.db");
  if (existsSync(legacyDb) && !samePath(legacyDb, dbFile())) {
    const p = readProfileFromDb(legacyDb);
    if (p) return p;
  }
  for (const dir of legacySourceDirs(sharedDir)) {
    const p = readProfileFromJson(path.join(dir, "profile.json"));
    if (p) return p;
  }
  return null;
}

function readEntriesFromDb(dbPath: string): Entry[] {
  try {
    const legacy = new DatabaseSync(dbPath);
    let rows: EntryRow[] = [];
    try {
      rows = legacy
        .prepare("SELECT id, timestamp, volumeMl, abv, label, gramsAlcohol FROM entries")
        .all() as unknown as EntryRow[];
    } catch {
      // Legacy DB without an entries table — nothing to import.
    }
    legacy.close();
    return rows.map(rowToEntry);
  } catch {
    return [];
  }
}

function readProfileFromDb(dbPath: string): Profile | null {
  try {
    const legacy = new DatabaseSync(dbPath);
    let row: (Profile & { rOverride: number | null }) | undefined;
    try {
      row = legacy.prepare("SELECT * FROM profile WHERE id = 1").get() as
        | (Profile & { rOverride: number | null })
        | undefined;
    } catch {
      row = undefined;
    }
    legacy.close();
    if (!row) return null;
    return { ...DEFAULT_PROFILE, ...row };
  } catch {
    return null;
  }
}

function readEntriesFromJson(file: string): Entry[] {
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Entry[];
  } catch {
    return [];
  }
}

function readProfileFromJson(file: string): Profile | null {
  if (!existsSync(file)) return null;
  try {
    return { ...DEFAULT_PROFILE, ...JSON.parse(readFileSync(file, "utf8")) } as Profile;
  } catch {
    return null;
  }
}

function writeProfileRow(database: DatabaseSync, p: Profile): void {
  database
    .prepare(
      `INSERT INTO profile (id, weightKg, sex, units, rOverride, betaRate, absorptionMinutes, dayStartHour, nonLiquorOffsetMinutes)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         weightKg = excluded.weightKg,
         sex = excluded.sex,
         units = excluded.units,
         rOverride = excluded.rOverride,
         betaRate = excluded.betaRate,
         absorptionMinutes = excluded.absorptionMinutes,
         dayStartHour = excluded.dayStartHour,
         nonLiquorOffsetMinutes = excluded.nonLiquorOffsetMinutes`
    )
    .run(
      p.weightKg,
      p.sex,
      p.units,
      p.rOverride ?? null,
      p.betaRate,
      p.absorptionMinutes,
      p.dayStartHour,
      p.nonLiquorOffsetMinutes
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
  // Drop null columns (e.g. a column added by migration to an existing row) so
  // they fall back to the defaults rather than overwriting them with null.
  const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v != null));
  const profile: Profile = { ...DEFAULT_PROFILE, ...clean };
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
