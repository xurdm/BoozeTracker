// Atomic JSON persistence for the profile and entries. Writes go to a temp
// file which is then renamed over the target, so a crash mid-write cannot
// corrupt the existing data.

import { promises as fs } from "fs";
import * as path from "path";
import { DEFAULT_PROFILE, type Entry, type Profile } from "../shared/types";

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const PROFILE_PATH = path.join(DATA_DIR, "profile.json");
const ENTRIES_PATH = path.join(DATA_DIR, "entries.json");

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function writeAtomic(filePath: string, data: unknown): Promise<void> {
  await ensureDataDir();
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

export async function getProfile(): Promise<Profile> {
  const stored = await readJson<Partial<Profile>>(PROFILE_PATH, {});
  // Merge with defaults so older/partial files gain new fields gracefully.
  return { ...DEFAULT_PROFILE, ...stored };
}

export async function saveProfile(profile: Profile): Promise<Profile> {
  const merged: Profile = { ...DEFAULT_PROFILE, ...profile };
  await writeAtomic(PROFILE_PATH, merged);
  return merged;
}

export async function getEntries(): Promise<Entry[]> {
  return readJson<Entry[]>(ENTRIES_PATH, []);
}

export async function saveEntries(entries: Entry[]): Promise<void> {
  await writeAtomic(ENTRIES_PATH, entries);
}

export async function addEntry(entry: Entry): Promise<Entry[]> {
  const entries = await getEntries();
  entries.push(entry);
  entries.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  await saveEntries(entries);
  return entries;
}

export async function deleteEntry(id: string): Promise<Entry[]> {
  const entries = await getEntries();
  const filtered = entries.filter((e) => e.id !== id);
  await saveEntries(filtered);
  return filtered;
}
