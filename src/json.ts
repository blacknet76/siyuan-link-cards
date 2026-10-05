import type { JsonValue } from "./schema.ts";

export function isJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return Object.keys(value).length === value.length && value.every(item => isJson(item, depth + 1));
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every(item => isJson(item, depth + 1));
}

export function encodeEntries(pairs: [string, JsonValue][], depth: number): string {
  if (!pairs.length) return "{}";
  const indent = "  ".repeat(depth + 1);
  return "{\n"
    + pairs.map(([key, value]) => `${indent}${JSON.stringify(key)}: ${encodeJson(value, depth + 1)}`).join(
      ",\n",
    ) + "\n" + "  ".repeat(depth) + "}";
}

function encodeJson(value: JsonValue, depth: number): string {
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    const indent = "  ".repeat(depth + 1);
    return "[\n" + value.map(item => indent + encodeJson(item, depth + 1)).join(",\n")
      + "\n" + "  ".repeat(depth) + "]";
  }
  if (value !== null && typeof value === "object") {
    return encodeEntries(Object.keys(value).sort().map(key => [key, value[key]!]), depth);
  }
  return JSON.stringify(value);
}
