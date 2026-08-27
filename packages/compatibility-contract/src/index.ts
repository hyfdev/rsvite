import ajv2020 from "ajv/dist/2020.js";
import ajvFormats from "ajv-formats";
import type { ErrorObject } from "ajv";
import capabilitySchema from "../schemas/capability.v1.schema.json" with { type: "json" };
import corpusManifestSchema from "../schemas/corpus-manifest.v1.schema.json" with { type: "json" };
import rawResultSchema from "../schemas/raw-result.v1.schema.json" with { type: "json" };

export { capabilitySchema, corpusManifestSchema, rawResultSchema };

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
  /**
   * The canonical check. A manifest and a result that are each shape-valid can still be
   * incoherent as evidence — a result can name an entry that does not exist, restate a
   * different source commit, claim a level the entry never declared, or report ownership
   * for capabilities the entry never expected. This validates both shapes and then the
   * relationship, so no caller can reach the relational rules by accident or skip them.
   *
   * One result covers one install plus one selected lifecycle command, while an entry's
   * `expectedCapabilities` is the target scope of the whole input. A result therefore names
   * the subset that run set out to verify, never necessarily all of it: a `dev` run was never
   * going to exercise the entry's build or preview capabilities, and requiring the full set
   * would make it claim runs that never happened. Whether the entry as a whole is covered is
   * a question across results, for the runner to answer.
   */
  validateResultAgainstManifest(manifest: unknown, result: unknown): ValidationResult;
}

const API_LEVELS = ["C0", "C1", "C2", "C3"] as const;

function violation(path: string, detail: string): ContractViolation {
  return { path, message: path === "" ? `document ${detail}` : `${path} ${detail}` };
}

function toViolation(error: ErrorObject): ContractViolation {
  const detail =
    error.keyword === "additionalProperties"
      ? `${error.message ?? "is invalid"} (${String(error.params["additionalProperty"])})`
      : (error.message ?? "is invalid");
  return violation(error.instancePath, detail);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Entry ids are the join key between a manifest and the results that reference it,
 * so a duplicate id would silently attribute results to the wrong input. JSON Schema
 * cannot express uniqueness by key, so the validator enforces it on top of the schema.
 */
function findDuplicateEntryIds(value: unknown): ContractViolation[] {
  const entries = asRecord(value)?.["entries"];
  if (!Array.isArray(entries)) return [];

  const seen = new Set<string>();
  const violations: ContractViolation[] = [];
  for (const [index, entry] of entries.entries()) {
    const id = asRecord(entry)?.["id"];
    if (typeof id !== "string") continue;
    if (seen.has(id)) {
      violations.push(violation(`/entries/${index}/id`, `duplicates an earlier entry id (${id})`));
    }
    seen.add(id);
  }
  return violations;
}

/** Two owners for one capability would make ownership unreadable rather than merely wrong. */
function findDuplicateCapabilityOwners(value: unknown): ContractViolation[] {
  const owners = asRecord(value)?.["capabilityOwners"];
  if (!Array.isArray(owners)) return [];

  const seen = new Set<string>();
  const violations: ContractViolation[] = [];
  for (const [index, entry] of owners.entries()) {
    const capability = asRecord(entry)?.["capability"];
    if (typeof capability !== "string") continue;
    if (seen.has(capability)) {
      violations.push(
        violation(`/capabilityOwners/${index}/capability`, `is recorded twice (${capability})`),
      );
    }
    seen.add(capability);
  }
  return violations;
}

/**
 * A declared fallback and an ownership record can each be well-formed while contradicting
 * each other. Whatever a fallback carried was executed by Vite's JavaScript core, so that
 * capability must appear in the ownership record as `compatibility-javascript` — reporting it
 * as Rust is a contradiction, and leaving it out of the record entirely is the same evasion
 * without the contradiction being visible.
 */
function findFallbackOwnershipConflicts(value: unknown): ContractViolation[] {
  const record = asRecord(value);
  const fallbacks = record?.["explicitFallbacks"];
  const owners = record?.["capabilityOwners"];
  if (!Array.isArray(fallbacks) || !Array.isArray(owners)) return [];

  const ownerByCapability = new Map<string, unknown>();
  for (const entry of owners) {
    const owned = asRecord(entry);
    const capability = owned?.["capability"];
    if (typeof capability === "string" && !ownerByCapability.has(capability)) {
      ownerByCapability.set(capability, owned?.["owner"]);
    }
  }

  const violations: ContractViolation[] = [];
  for (const [index, fallback] of fallbacks.entries()) {
    const carried = asRecord(fallback)?.["capabilities"];
    if (!Array.isArray(carried)) continue;
    for (const [position, capability] of carried.entries()) {
      if (typeof capability !== "string") continue;
      const path = `/explicitFallbacks/${index}/capabilities/${position}`;
      if (!ownerByCapability.has(capability)) {
        violations.push(violation(path, `has no owner in /capabilityOwners (${capability})`));
        continue;
      }
      const owner = ownerByCapability.get(capability);
      if (owner !== "compatibility-javascript") {
        violations.push(
          violation(
            path,
            `was carried by a fallback, so it cannot be owned by ${String(owner)} (${capability})`,
          ),
        );
      }
    }
  }
  return violations;
}

/** Only formats are checked by the schema; the order of two valid timestamps is not. */
function findReversedTimestamps(value: unknown): ContractViolation[] {
  const record = asRecord(value);
  const startedAt = record?.["startedAt"];
  const finishedAt = record?.["finishedAt"];
  if (typeof startedAt !== "string" || typeof finishedAt !== "string") return [];

  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(finish) || finish >= start) return [];
  return [violation("/finishedAt", "is earlier than /startedAt")];
}

function capabilitiesOf(owners: unknown): string[] {
  if (!Array.isArray(owners)) return [];
  return owners
    .map((entry) => asRecord(entry)?.["capability"])
    .filter((capability): capability is string => typeof capability === "string");
}

function findPairViolations(manifest: unknown, result: unknown): ContractViolation[] {
  const entries = asRecord(manifest)?.["entries"];
  const resultRecord = asRecord(result);
  const reference = asRecord(resultRecord?.["manifestEntry"]);
  const id = reference?.["id"];
  if (!Array.isArray(entries) || typeof id !== "string") return [];

  const entry = asRecord(entries.find((candidate) => asRecord(candidate)?.["id"] === id));
  if (entry === undefined) {
    return [violation("/manifestEntry/id", `names no entry in the manifest (${id})`)];
  }

  const violations: ContractViolation[] = [];

  const entryCommit = asRecord(entry["source"])?.["commit"];
  const resultCommit = reference?.["sourceCommit"];
  if (typeof entryCommit === "string" && resultCommit !== entryCommit) {
    violations.push(
      violation(
        "/manifestEntry/sourceCommit",
        `does not match the manifest entry's source commit (${entryCommit})`,
      ),
    );
  }

  // The level a run reached may sit below the level the entry declares, never above it:
  // a subject cannot demonstrate an API surface the input never exercised.
  const entryLevel = entry["javascriptApiLevel"];
  const resultLevel = resultRecord?.["javascriptApiLevel"];
  if (typeof entryLevel === "string" && typeof resultLevel === "string") {
    const declared = API_LEVELS.indexOf(entryLevel as (typeof API_LEVELS)[number]);
    const measured = API_LEVELS.indexOf(resultLevel as (typeof API_LEVELS)[number]);
    if (declared >= 0 && measured > declared) {
      violations.push(
        violation(
          "/javascriptApiLevel",
          `is higher than the level the manifest entry declares (${entryLevel})`,
        ),
      );
    }
  }

  // The same lockfile and package manager are what make the two subjects comparable.
  const entryManager = asRecord(asRecord(entry["lockfile"])?.["packageManager"]);
  const resultManager = asRecord(asRecord(resultRecord?.["environment"])?.["packageManager"]);
  if (entryManager !== undefined && resultManager !== undefined) {
    for (const field of ["name", "version"] as const) {
      if (resultManager[field] !== entryManager[field]) {
        violations.push(
          violation(
            `/environment/packageManager/${field}`,
            `does not match the manifest entry's lockfile package manager (${String(entryManager[field])})`,
          ),
        );
      }
    }
  }

  const expected = entry["expectedCapabilities"];
  if (Array.isArray(expected)) {
    const declaredCapabilities = new Set(
      expected.filter((c): c is string => typeof c === "string"),
    );
    const measured = capabilitiesOf(resultRecord?.["capabilityOwners"]);
    for (const [index, capability] of measured.entries()) {
      if (!declaredCapabilities.has(capability)) {
        violations.push(
          violation(
            `/capabilityOwners/${index}/capability`,
            `is not declared by the manifest entry (${capability})`,
          ),
        );
      }
    }
    const fallbacks = resultRecord?.["explicitFallbacks"];
    if (Array.isArray(fallbacks)) {
      for (const [index, fallback] of fallbacks.entries()) {
        const carried = asRecord(fallback)?.["capabilities"];
        if (!Array.isArray(carried)) continue;
        for (const [position, capability] of carried.entries()) {
          if (typeof capability === "string" && !declaredCapabilities.has(capability)) {
            violations.push(
              violation(
                `/explicitFallbacks/${index}/capabilities/${position}`,
                `is not declared by the manifest entry (${capability})`,
              ),
            );
          }
        }
      }
    }
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
  ajv.addSchema(capabilitySchema);

  const manifestShape = ajv.compile(corpusManifestSchema);
  const resultShape = ajv.compile(rawResultSchema);

  function checkManifest(value: unknown): ContractViolation[] {
    const schemaViolations = manifestShape(value)
      ? []
      : (manifestShape.errors ?? []).map(toViolation);
    return [...schemaViolations, ...findDuplicateEntryIds(value)];
  }

  function checkResult(value: unknown): ContractViolation[] {
    const schemaViolations = resultShape(value) ? [] : (resultShape.errors ?? []).map(toViolation);
    return [
      ...schemaViolations,
      ...findDuplicateCapabilityOwners(value),
      ...findFallbackOwnershipConflicts(value),
      ...findReversedTimestamps(value),
    ];
  }

  function report(violations: readonly ContractViolation[]): ValidationResult {
    return violations.length === 0 ? { valid: true } : { valid: false, violations };
  }

  return {
    validateCorpusManifest: (value) => report(checkManifest(value)),
    validateRawResult: (value) => report(checkResult(value)),
    validateResultAgainstManifest(manifest, result) {
      const shapeViolations = [...checkManifest(manifest), ...checkResult(result)];
      // Relational rules read fields the shapes guarantee, so they only run once both hold.
      if (shapeViolations.length > 0) return report(shapeViolations);
      return report(findPairViolations(manifest, result));
    },
  };
}
