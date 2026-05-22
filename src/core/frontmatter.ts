import type { FrontmatterData, YamlValue } from "./types.ts";

export function parseFrontmatter(text: string): { data: FrontmatterData; body: string } {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { data: {}, body: text };
  }

  const normalized = text.replace(/\r\n/g, "\n");
  const end = findFrontmatterEnd(normalized);
  if (end === -1) {
    return { data: {}, body: text };
  }

  const raw = normalized.slice(4, end).trim();
  const closingLength = normalized.startsWith("\n---\n", end) ? 5 : 4;
  const body = normalized.slice(end + closingLength);
  return { data: parseSimpleYaml(raw), body };
}

function findFrontmatterEnd(text: string): number {
  const withBody = text.indexOf("\n---\n", 4);
  if (withBody !== -1) return withBody;
  if (text.endsWith("\n---")) return text.length - 4;
  return -1;
}

function parseSimpleYaml(raw: string): FrontmatterData {
  const data: FrontmatterData = {};

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf(":");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    data[key] = parseYamlValue(value);
  }

  return data;
}

function parseYamlValue(value: string): YamlValue {
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => stripQuotes(item.trim()));
  }

  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;

  return stripQuotes(value);
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
