// Thin fetch wrappers around the JSON API.

import type { Entry, Profile } from "../shared/types.js";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchProfile(): Promise<Profile> {
  return json<Profile>(await fetch("/api/profile"));
}

export async function updateProfile(profile: Profile): Promise<Profile> {
  return json<Profile>(
    await fetch("/api/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile)
    })
  );
}

export async function fetchEntries(): Promise<Entry[]> {
  return json<Entry[]>(await fetch("/api/entries"));
}

export async function addEntry(input: {
  volumeMl: number;
  abv: number;
  label?: string;
  timestamp?: string;
}): Promise<{ entry: Entry; entries: Entry[] }> {
  return json(
    await fetch("/api/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    })
  );
}

export async function deleteEntry(id: string): Promise<{ entries: Entry[] }> {
  return json(await fetch(`/api/entries/${id}`, { method: "DELETE" }));
}
