import { DomainValidationError } from "./ports.ts";

export type AudienceSyntax = "scoped-v1" | "scoped-fallback-v1";
export type PerformanceSpan = { audience: string[] | null; primary: string; fallback: string | null };
export type ScopedPerformance = {
  version: 1;
  syntax: AudienceSyntax;
  baseAudience: string[] | null;
  spans: PerformanceSpan[];
  projections: { actorId: string; text: string }[];
};
export type AuthoringIdentity = { id: string; name: string };

export function assertAudienceSyntax(value: unknown): asserts value is AudienceSyntax {
  if (value !== "scoped-v1" && value !== "scoped-fallback-v1")
    throw new DomainValidationError("Unsupported audience syntax.");
}

export function validateScopedPerformance(value: unknown): asserts value is ScopedPerformance {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item);
  const exact = (item: Record<string, unknown>, keys: string[]) => Object.keys(item).length === keys.length && keys.every(key => Object.hasOwn(item, key));
  const ids = (item: unknown): item is string[] => Array.isArray(item) && item.every(id => typeof id === "string" && !!id) && new Set(item).size === item.length;
  if (!object(value) || !exact(value, ["version", "syntax", "baseAudience", "spans", "projections"]) || value.version !== 1)
    throw new DomainValidationError("Invalid scoped performance.");
  assertAudienceSyntax(value.syntax);
  if (!(value.baseAudience === null || ids(value.baseAudience)) || !Array.isArray(value.spans) || !Array.isArray(value.projections))
    throw new DomainValidationError("Invalid scoped performance audiences.");
  for (const span of value.spans) if (!object(span) || !exact(span, ["audience", "primary", "fallback"]) ||
    !(span.audience === null || ids(span.audience)) || typeof span.primary !== "string" || !(span.fallback === null || typeof span.fallback === "string"))
    throw new DomainValidationError("Invalid performance span.");
  for (const projection of value.projections) if (!object(projection) || !exact(projection, ["actorId", "text"]) ||
    typeof projection.actorId !== "string" || !projection.actorId || typeof projection.text !== "string" || !projection.text.trim())
    throw new DomainValidationError("Invalid character projection.");
  if (new Set(value.projections.map(p => p.actorId)).size !== value.projections.length)
    throw new DomainValidationError("Duplicate character projection.");
}

/** Flat scopes resolve once, against the pinned cast. No presence or access inference. */
export function parsePerformance(input: {
  text: string; actorId: string; audience: string[] | null;
  identities: AuthoringIdentity[]; syntax: AudienceSyntax;
}): { actorId: string; audience: string[]; performance: ScopedPerformance } {
  assertAudienceSyntax(input.syntax);
  const resolve = (label: string): string => {
    const matches = input.identities.filter(actor => actor.id === label || actor.name === label);
    if (matches.length !== 1) throw new DomainValidationError(`Unresolved or ambiguous identity: ${label}`);
    return matches[0]!.id;
  };
  // Selector tokens are IDs or single-token display names; multiword names use IDs.
  const selector = /^#([\p{L}\p{N}_-]+(?:,[\p{L}\p{N}_-]+)*)/u;
  const recipients = (labels: string) => [...new Set(labels.split(",").map(resolve))];
  const text = input.text.trim();
  let pos = 0, actorId = input.actorId;
  if (text.startsWith("@")) {
    const acting = /^@([\p{L}\p{N}_-]+)(?=\s|$)/u.exec(text);
    if (!acting) throw new DomainValidationError("Malformed actor selector.");
    actorId = resolve(acting[1]!); pos = acting[0].length;
    while (/\s/u.test(text[pos] ?? "") && pos < text.length) pos++;
  }
  if (!input.identities.some(actor => actor.id === actorId)) throw new DomainValidationError("Choose a valid actor.");
  let base = input.audience === null ? null : [...new Set(input.audience)];
  for (const id of base ?? []) if (!input.identities.some(actor => actor.id === id))
    throw new DomainValidationError(`Unresolved audience identity: ${id}`);
  const leading = selector.exec(text.slice(pos));
  if (leading && text[pos + leading[0].length] !== "(") {
    const end = pos + leading[0].length;
    if (end < text.length && !/\s/u.test(text[end]!)) throw new DomainValidationError("Malformed turn audience.");
    base = recipients(leading[1]!); pos = end;
    while (/\s/u.test(text[pos] ?? "") && pos < text.length) pos++;
  }
  const spans: PerformanceSpan[] = [];
  let unscoped = "";
  const flush = () => {
    if (!unscoped) return;
    if (base === null && unscoped.trim()) throw new DomainValidationError("Choose a default or turn audience for unscoped text.");
    spans.push({ audience: base, primary: unscoped, fallback: null }); unscoped = "";
  };
  const escaped = () => text[pos] === "\\" && "\\()|#@".includes(text[pos + 1] ?? "\u0000");
  while (pos < text.length) {
    if (escaped()) { unscoped += text[pos + 1]; pos += 2; continue; }
    if (text[pos] !== "#") { unscoped += text[pos++]; continue; }
    const scope = selector.exec(text.slice(pos));
    if (!scope || text[pos + scope[0].length] !== "(")
      throw new DomainValidationError("Malformed audience scope; escape a literal # as \\#.");
    flush();
    const audience = recipients(scope[1]!);
    pos += scope[0].length + 1;
    let depth = 1, primary = "", fallback: string | null = null;
    const append = (value: string) => { if (fallback === null) primary += value; else fallback += value; };
    while (pos < text.length && depth > 0) {
      if (escaped()) { append(text[pos + 1]!); pos += 2; continue; }
      const char = text[pos++]!;
      if (char === "#") throw new DomainValidationError("Nested audience scopes are unsupported; escape a literal #.");
      if (char === "(") depth++;
      if (char === ")" && --depth === 0) break;
      if (char === "|" && depth === 1) {
        if (input.syntax !== "scoped-fallback-v1") throw new DomainValidationError("Observer fallbacks require explicit opt-in.");
        if (fallback !== null) throw new DomainValidationError("A scope may have only one fallback separator.");
        if (base === null) throw new DomainValidationError("Observer fallback requires a resolved base audience.");
        fallback = ""; continue;
      }
      append(char);
    }
    if (depth !== 0) throw new DomainValidationError("Unclosed audience scope.");
    if (fallback !== null && !primary.trim()) throw new DomainValidationError("An observer fallback requires a nonempty primary performance.");
    spans.push({ audience, primary, fallback });
  }
  flush();
  const projected = new Map<string, string>([[actorId, ""]]);
  for (const span of spans) {
    for (const id of new Set([actorId, ...(span.audience ?? [])])) projected.set(id, (projected.get(id) ?? "") + span.primary);
    for (const id of base ?? []) if (id !== actorId && !span.audience?.includes(id) && span.fallback !== null)
      projected.set(id, (projected.get(id) ?? "") + span.fallback);
  }
  const projections = [...projected].flatMap(([id, value]) => value.trim() ? [{ actorId: id, text: value.trim() }] : []);
  if (!projections.length) throw new DomainValidationError("Turn contains no performance.");
  return { actorId, audience: projections.map(p => p.actorId),
    performance: { version: 1, syntax: input.syntax, baseAudience: base, spans, projections } };
}

/** Return a model-safe transcript record, with no scope structure or recipient union. */
export function projectTurn<T extends { actorId: string; text: string; audience: string[]; performance?: ScopedPerformance }>(
  turn: T, observerId: string,
): Omit<T, "performance"> | null {
  const { performance, ...visible } = turn;
  if (!performance) return turn.audience.includes(observerId) ? visible : null;
  const projection = performance.projections.find(p => p.actorId === observerId);
  return projection ? { ...visible, text: projection.text, audience: [observerId] } : null;
}

/** A body-only correction keeps the saved audience structure and creates fresh projections. */
export function correctScopedPerformance(
  turn: { actorId: string; audience: string[]; performance?: ScopedPerformance }, text: string, identities: AuthoringIdentity[],
): ScopedPerformance | undefined {
  if (!turn.performance) return undefined;
  const original = turn.performance;
  const next = parsePerformance({ text, identities, actorId: turn.actorId, audience: original.baseAudience, syntax: original.syntax });
  const routing = (performance: ScopedPerformance) => JSON.stringify([
    performance.baseAudience, performance.spans.map(span => [span.audience, span.fallback !== null]),
  ]);
  if (next.actorId !== turn.actorId || routing(next.performance) !== routing(original) ||
      JSON.stringify([...next.audience].sort()) !== JSON.stringify([...turn.audience].sort()))
    throw new DomainValidationError("Audience changes require a replacement turn rather than a body-only correction.");
  return next.performance;
}
