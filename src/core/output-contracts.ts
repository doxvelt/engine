import type { OutputSchemaRef } from "./types.ts";

/** Doxvelt's versioned output contract, independent of provider request syntax. */
export const AUDIENCE_PROPOSAL_SCHEMA_REF: Readonly<OutputSchemaRef> = Object.freeze({
  id: "audience-proposal", digest: "v1",
});

export const AUDIENCE_PROPOSAL_JSON_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({
    text: Object.freeze({ type: "string" }),
    audience: Object.freeze({ type: "array", items: Object.freeze({ type: "string" }) }),
  }),
  required: Object.freeze(["text", "audience"]),
  additionalProperties: false,
});

/** No inference from names, prompts, hosts or partially matching schema refs. */
export function actorOutputContract(ref: Readonly<OutputSchemaRef>): "audience-proposal" | "legacy-text" | null {
  if (ref.id === AUDIENCE_PROPOSAL_SCHEMA_REF.id && ref.digest === AUDIENCE_PROPOSAL_SCHEMA_REF.digest)
    return "audience-proposal";
  if (ref.id === "screenplay" && ref.digest === "schema-v1") return "legacy-text";
  return null;
}
