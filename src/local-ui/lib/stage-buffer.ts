import type { HistoryBuffer } from "./stage-history.ts";
export type RoutingBuffer = { actorId: string; audienceMode: "all" | "selected" | "unspecified"; audienceIds: string[] };
export type CorrectionBuffer = { audience: string[]; text: string; required: boolean; confirmed: boolean };
export type FrozenRequest = { suffix: string; body: Record<string, unknown> };
export type StageBuffer = {
  basis: string; mode: "direct" | "perform"; routing: { direct: RoutingBuffer; perform: RoutingBuffer };
  direction: string; performance: string; selected: string | null; editing: boolean;
  reviews: { id: string; basis: string; text: string; correction: CorrectionBuffer }[];
  history: HistoryBuffer; requests: FrozenRequest[];
};
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === "string" && x.length <= 100_000;
const ids = (x: unknown): x is string[] => Array.isArray(x) && x.length <= 10000 && x.every(text);
const nullableText = (x: unknown) => x === null || text(x);
const exact = (x: unknown, keys: string[]) => object(x) && Object.keys(x).every(k => keys.includes(k)) && keys.every(k => Object.hasOwn(x, k));
const selectionKeys = ["sourceBranchId", "expectedHead", "sourceCommitId", "messageVersionId", "logicalMessageId", "actorId"];
function editor(x: unknown): boolean {
  return exact(x, ["selection", "action", "performance", "whisper", "confirmed", "audience", "propose", "revision"]) && object(x) &&
    exact(x.selection, selectionKeys) && object(x.selection) && Object.values(x.selection).every(text) &&
    ["manual", "generate"].includes(String(x.action)) && text(x.performance) && text(x.whisper) && typeof x.confirmed === "boolean" &&
    ids(x.audience) && typeof x.propose === "boolean" && Number.isSafeInteger(x.revision) && Number(x.revision) >= 0;
}
/** Stored data is untrusted. Only the bounded Stage command transports can replay. */
export function validFrozenRequest(x: unknown): x is FrozenRequest {
  if (!exact(x, ["suffix", "body"]) || !object(x) || typeof x.suffix !== "string" || !object(x.body)) return false;
  const b = x.body;
  const schemas: [RegExp, string[], string[]][] = [
    [/^\/turns$/, ["commandId", "branchId", "expectedHead", "actorId", "audience", "manualText", "stageWhisperIds", "knowledgePolicy"], []],
    [/^\/whispers$/, ["commandId", "branchId", "expectedHead", "targetActorId", "text"], []],
    [/^\/drafts$/, ["commandId", "branchId", "expectedHead", "actorId", "audience", "stageWhisperIds", "draftingPolicy", "completeWhisper"], []],
    [/^\/drafts\/[^/?#]+\/accept$/, ["commandId"], ["finalText"]],
    [/^\/drafts\/[^/?#]+\/(retry|discard)$/, ["commandId"], []],
    [/^\/drafts\/[^/?#]+\/revise$/, ["commandId", "draftingPolicy", "audience", "completeWhisper"], ["preservedText"]],
    [/^\/alternatives$/, [...selectionKeys, "commandId", "action", "audience"], ["manualText", "completeWhisper"]],
    [/^\/alternatives\/[^/?#]+\/retry$/, ["commandId"], []],
    [/^\/alternatives\/[^/?#]+\/discard$/, [], []],
  ];
  const schema = schemas.find(([pattern]) => pattern.test(x.suffix as string));
  if (!schema || schema[1].some(k => !Object.hasOwn(b, k)) || Object.keys(b).some(k => ![...schema[1], ...schema[2]].includes(k))) return false;
  if (!Object.entries(b).every(([k, v]) => ["audience", "stageWhisperIds"].includes(k) ? (k === "audience" && v === null) || ids(v) : text(v))) return false;
  if ("action" in b && !["manual", "generate"].includes(String(b.action))) return false;
  if ("draftingPolicy" in b && b.draftingPolicy !== "actor-knowledge-v1") return false;
  if ("knowledgePolicy" in b && b.knowledgePolicy !== "actor-knowledge-v1") return false;
  return true;
}
export function validStageBuffer(x: unknown): x is StageBuffer {
  if (!exact(x, ["basis", "mode", "routing", "direction", "performance", "selected", "editing", "reviews", "history", "requests"]) || !object(x)) return false;
  if (!text(x.basis) || !["direct", "perform"].includes(String(x.mode)) || !text(x.direction) || !text(x.performance) || !nullableText(x.selected) || typeof x.editing !== "boolean") return false;
  if (!exact(x.routing, ["direct", "perform"]) || !object(x.routing) || !Object.values(x.routing).every(r => exact(r, ["actorId", "audienceMode", "audienceIds"]) && object(r) && text(r.actorId) && ["all", "selected", "unspecified"].includes(String(r.audienceMode)) && ids(r.audienceIds))) return false;
  if (!Array.isArray(x.reviews) || !x.reviews.every(r => exact(r, ["id", "basis", "text", "correction"]) && text(r.id) && text(r.basis) && text(r.text) && exact(r.correction, ["audience", "text", "required", "confirmed"]) && ids(r.correction.audience) && text(r.correction.text) && typeof r.correction.required === "boolean" && typeof r.correction.confirmed === "boolean")) return false;
  if (new Set(x.reviews.map(r => r.id)).size !== x.reviews.length || (x.selected !== null && !x.reviews.some(r => r.id === x.selected))) return false;
  if (!exact(x.history, ["editor", "command"]) || !object(x.history) || !(x.history.editor === null || editor(x.history.editor))) return false;
  const c = x.history.command;
  if (c !== null && (!exact(c, ["suffix", "body", "editor", "operationId"]) || !object(c) || !validFrozenRequest({ suffix: c.suffix, body: c.body }) || !editor(c.editor) || !nullableText(c.operationId))) return false;
  return Array.isArray(x.requests) && x.requests.every(validFrozenRequest);
}
