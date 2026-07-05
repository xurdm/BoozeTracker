// Shared domain types used by both the server and the browser client.

export type Sex = "male" | "female";
export type Units = "imperial" | "metric";

export interface Profile {
  /** Body weight in kilograms (stored canonically in metric). */
  weightKg: number;
  /** Biological sex, used to pick a default Widmark distribution factor. */
  sex: Sex;
  /** Preferred display units for the UI. Storage is always metric. */
  units: Units;
  /** Optional manual override for the Widmark r distribution factor. */
  rOverride?: number;
  /** Alcohol elimination rate in BAC %/hour (Widmark beta). */
  betaRate: number;
  /** Linear absorption window in minutes for each drink. */
  absorptionMinutes: number;
  /** Hour (local, 0-23) at which a new "night" begins. */
  dayStartHour: number;
}

export interface Entry {
  id: string;
  /** ISO-8601 UTC timestamp of when the drink was consumed. */
  timestamp: string;
  /** Volume of the drink in millilitres. */
  volumeMl: number;
  /** Alcohol by volume as a percentage (e.g. 5 for 5%). */
  abv: number;
  /** Optional human-readable label, e.g. "Beer 12oz 5%". */
  label?: string;
  /** Pure ethanol mass in grams (derived, stored for convenience). */
  gramsAlcohol: number;
}

export const DEFAULT_PROFILE: Profile = {
  weightKg: 80,
  sex: "male",
  units: "imperial",
  betaRate: 0.015,
  absorptionMinutes: 30,
  dayStartHour: 20
};
