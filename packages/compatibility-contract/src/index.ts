import ajv2020 from "ajv/dist/2020.js";
import ajvFormats from "ajv-formats";
import type { ErrorObject } from "ajv";
import corpusManifestSchema from "../schemas/corpus-manifest.v1.schema.json" with { type: "json" };
import rawResultSchema from "../schemas/raw-result.v1.schema.json" with { type: "json" };

export { corpusManifestSchema, rawResultSchema };

// ajv and ajv-formats are CommonJS. Node hands their callable export straight to the default
// import, but TypeScript models it as the module namespace, so both are retyped here rather
// than at every use. Only the types change; the imported values are already the right ones.
const Ajv2020 = ajv2020 as unknown as typeof ajv2020.default;
const addFormats = ajvFormats as unknown as typeof ajvFormats.default;

/** A single reason a document was rejected. */
export interface ContractViolation {
  /** JSON Pointer to the offending location, empty for the document root. */
  readonly path: string;
  /** Human-readable reason, suitable for a runner log or a CI failure. */
  readonly message: string;
}

export type ValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly violations: readonly ContractViolation[] };

/**
 * The schemas are the normative definition of the contract. This module deliberately
 * exports no TypeScript shape for a manifest or a result: a hand-written mirror could
 * drift from the schema without any check noticing, and the schema is what validation,
 * runners and adapters agree on.
 */
export interface ContractValidators {
  validateCorpusManifest(value: unknown): ValidationResult;
  validateRawResult(value: unknown): ValidationResult;
}

function toViolation(error: ErrorObject): ContractViolation {
  const path = error.instancePath;
  const detail =
    error.keyword === "additionalProperties"
      ? `${error.message ?? "is invalid"} (${String(error.params["additionalProperty"])})`
      : (error.message ?? "is invalid");
  return { path, message: path === "" ? `document ${detail}` : `${path} ${detail}` };
}

/**
 * Entry ids are the join key between a manifest and every result that references it,
 * so a duplicate id would silently attribute results to the wrong input. JSON Schema
 * cannot express uniqueness by key, so the validator enforces it on top of the schema.
 */
function findDuplicateEntryIds(value: unknown): readonly ContractViolation[] {
  if (typeof value !== "object" || value === null) return [];
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];

  const seen = new Set<string>();
  const violations: ContractViolation[] = [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string") continue;
    if (seen.has(id)) {
      violations.push({
        path: `/entries/${index}/id`,
        message: `/entries/${index}/id duplicates an earlier entry id (${id})`,
      });
    }
    seen.add(id);
  }
  return violations;
}

/**
 * Builds the one validation configuration the project uses. Formats are enforced rather
 * than annotated, so a malformed timestamp or source URL fails instead of passing quietly.
 */
export function createContractValidators(): ContractValidators {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);

  const manifest = ajv.compile(corpusManifestSchema);
  const result = ajv.compile(rawResultSchema);

  return {
    validateCorpusManifest(value: unknown): ValidationResult {
      const schemaViolations = manifest(value) ? [] : (manifest.errors ?? []).map(toViolation);
      const violations = [...schemaViolations, ...findDuplicateEntryIds(value)];
      return violations.length === 0 ? { valid: true } : { valid: false, violations };
    },
    validateRawResult(value: unknown): ValidationResult {
      if (result(value)) return { valid: true };
      return { valid: false, violations: (result.errors ?? []).map(toViolation) };
    },
  };
}
