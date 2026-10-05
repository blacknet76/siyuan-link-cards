import english from "./i18n/en.json" with { type: "json" };

export type Strings = typeof english;

export function localizedStrings(values: Record<string, unknown>): Strings {
  return Object.fromEntries(
    Object.entries(english).map(([key, fallback]) => [
      key,
      typeof values[key] === "string" && values[key] ? values[key] : fallback,
    ]),
  ) as Strings;
}
