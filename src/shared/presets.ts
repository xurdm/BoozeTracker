// Preset volumes, ABVs, and one-tap drink cards. Volumes are stored in mL.

export const ML_PER_OZ = 29.5735;

export interface VolumePreset {
  label: string;
  ml: number;
}

export interface AbvPreset {
  label: string;
  abv: number;
}

export interface DrinkPreset {
  label: string;
  ml: number;
  abv: number;
  /** Emoji shown on the tappable card. */
  icon: string;
}

const oz = (n: number) => Math.round(n * ML_PER_OZ);

export const VOLUME_PRESETS: VolumePreset[] = [
  { label: "1.5 oz", ml: oz(1.5) },
  { label: "5 oz", ml: oz(5) },
  { label: "8 oz", ml: oz(8) },
  { label: "12 oz", ml: oz(12) },
  { label: "16 oz", ml: oz(16) }
];

export const ABV_PRESETS: AbvPreset[] = [
  { label: "4%", abv: 4 },
  { label: "5%", abv: 5 },
  { label: "8%", abv: 8 },
  { label: "12%", abv: 12 },
  { label: "40%", abv: 40 },
  { label: "50%", abv: 50 }
];

export type DrinkType = "Beer" | "Wine" | "Liquor" | "Cocktail" | "Other";

export const DRINK_TYPES: DrinkType[] = ["Beer", "Wine", "Liquor", "Cocktail", "Other"];

const TYPE_KEYWORDS: Array<{ type: DrinkType; words: string[] }> = [
  { type: "Beer", words: ["beer", "ipa", "lager", "ale", "pilsner", "stout", "cider"] },
  { type: "Wine", words: ["wine", "champagne", "prosecco", "rosé", "rose", "sangria"] },
  { type: "Cocktail", words: ["cocktail", "margarita", "martini", "mojito", "negroni", "spritz"] },
  { type: "Liquor", words: ["shot", "whiskey", "whisky", "vodka", "tequila", "rum", "gin", "liquor", "bourbon", "scotch"] }
];

/**
 * Categorise a drink into a coarse type from its label. Custom combos (which
 * have no descriptive label) fall back to a high-ABV heuristic, else "Other".
 */
export function categorizeDrink(label: string | undefined, abv: number): DrinkType {
  const text = (label ?? "").toLowerCase();
  for (const { type, words } of TYPE_KEYWORDS) {
    if (words.some((w) => text.includes(w))) return type;
  }
  // No descriptive keyword (e.g. a custom combo like "355 mL @ 5%"): use ABV.
  if (label === undefined || /^\d/.test(text)) {
    if (abv >= 30) return "Liquor";
    if (abv >= 10) return "Wine";
    if (abv > 0) return "Beer";
  }
  return "Other";
}

export const DRINK_PRESETS: DrinkPreset[] = [
  { label: "Light Tall Beer 16oz 4%", ml: oz(16), abv: 4, icon: "🍺" },
  { label: "Shot 1.5oz 40%", ml: oz(1.5), abv: 40, icon: "🥃" },
  { label: "Tall Beer 16oz 5%", ml: oz(16), abv: 5, icon: "🍺" },
  { label: "Light Beer 12oz 4%", ml: oz(12), abv: 4, icon: "🍺" },
  { label: "Strong Shot 1.5oz 50%", ml: oz(1.5), abv: 50, icon: "🥃" },
  { label: "Beer 12oz 5%", ml: oz(12), abv: 5, icon: "🍺" },
  { label: "IPA 12oz 8%", ml: oz(12), abv: 8, icon: "🍺" },
  { label: "Wine 5oz 12%", ml: oz(5), abv: 12, icon: "🍷" }
];
