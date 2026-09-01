/**
 *
 * Each registered case corresponds to exactly one catalog variant.
 *
 * Fingerprints:
 * semanticFingerprint canonicalizes contract meaning as JSON.
 * semanticFingerprint ignores JSON formatting and key order.
 * implementationBundleDigest hashes the explicit implementation file list.
 * implementationBundleDigest hashes the bytes of each listed source file.
 * ledgerFingerprint hashes the full adjudication ledger lines.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import {
    EXECUTABLE_LANES,
    VARIANT_ID_RE,
    type IncidentCatalog,
    type IncidentVariant,
} from "./contract";
import { rowDigest } from "./history";
import {
    isVerifiedProspectiveSource,
    type VerifiedProspectiveIncidentSource,
} from "./evidence";
import { auditBackgroundLifecycleIncidentCases } from "./scenarios/audit-background-lifecycle";
import { auditMemorySearchIncidentCases } from "./scenarios/audit-memory-search";
import { parityPiTodoIncidentCases } from "./scenarios/parity-pi-todo";
import { paritySyntheticTodoIncidentCases } from "./scenarios/parity-synthetic-todo";
import { sourceLinkedRegressionIncidentCases } from "./scenarios/source-linked-regressions";

export const SEMANTIC_FINGERPRINT_CONTRACT = "incident-semantic-fingerprint/v1";
export const IMPLEMENTATION_BUNDLE_CONTRACT =
    "incident-implementation-bundle/v1";
export const LEDGER_FINGERPRINT_CONTRACT = "incident-ledger-fingerprint/v1";

export interface CaseDriverContext {
    workspaceRoot: string;
    storeDir: string;
    storeNamespace: string;
}

/**
 * */
export type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [key: string]: JsonValue };
export type NormalizedObservation = JsonValue;

export interface VerifierCheck {
    /** id identifies a check declared in the variant's normative_checks. */
    id: string;
    passed: boolean;
}

export type PreconditionOutcome =
    | { satisfied: true }
    | {
          satisfied: false;
          reason: "blocked_by_dependency" | "precondition_unmet";
          /** blockedBy lists the catalog dependencies reviewed for blocked_by_dependency. */
          blockedBy: string[];
      };

export type PrerequisiteOutcome = { ok: true } | { ok: false; reason: string };

export interface RegisteredIncidentCase {
    variantId: string;
    /** Repo-root-relative driver/verifier/normalizer/fixture/dependency
     * implementationFiles lists repo-root-relative driver, verifier, normalizer, fixture, and dependency files hashed into implementationBundleDigest. */
    implementationFiles: string[];
    /** fixtures contribute structured meaning, rather than raw bytes, to semanticFingerprint.
     *  fingerprint. */
    fixtures: Record<string, unknown>;
    /** driver throws infrastructure errors; otherwise, driver returns serializable observations. */
    driver(context: CaseDriverContext): Promise<JsonValue>;
    normalizer(raw: JsonValue): NormalizedObservation;
    /** precondition runs before verifier. */
    precondition(observation: NormalizedObservation): PreconditionOutcome;
    /* */
    verifier(observation: NormalizedObservation): VerifierCheck[];
    /** binding stores the exact driver and verifier functions executed by the case so validation can match catalog file#symbol bindings.
     * */
    binding: { driver: unknown; verifier: unknown };
    /** prerequisite reports `unavailable` when the parent-side availability probe misses. */
    prerequisite?(): PrerequisiteOutcome;
}

export type IncidentCaseRegistry = Map<string, RegisteredIncidentCase>;

/* */
function validateImplementationFiles(files: string[], variantId: string): void {
    if (files.length === 0) {
        throw new Error(
            `case ${variantId}: implementation file list must not be empty`,
        );
    }
    const seen = new Set<string>();
    for (const file of files) {
        if (
            file.trim().length === 0 ||
            isAbsolute(file) ||
            file.split(/[\\/]/).includes("..")
        ) {
            throw new Error(
                `case ${variantId}: implementation file ${file} must be a root-confined relative path`,
            );
        }
        if (seen.has(file))
            throw new Error(
                `case ${variantId}: duplicate implementation file ${file}`,
            );
        seen.add(file);
    }
}

export function registerProspectiveIncidentCase(
    registry: IncidentCaseRegistry,
    source: VerifiedProspectiveIncidentSource,
    entry: RegisteredIncidentCase,
): void {
    if (!isVerifiedProspectiveSource(source)) {
        throw new Error("prospective incident registration requires verified source evidence");
    }
    if (entry.fixtures.prospectiveSourceFingerprint !== rowDigest(source)) {
        throw new Error("prospective incident registration does not bind its source contract");
    }
    registerIncidentCase(registry, entry);
}

export function registerIncidentCase(
    registry: IncidentCaseRegistry,
    entry: RegisteredIncidentCase,
): void {
    if (!VARIANT_ID_RE.test(entry.variantId)) {
        throw new Error(
            `registered case has invalid variant id ${entry.variantId}`,
        );
    }
    if (registry.has(entry.variantId)) {
        throw new Error(
            `duplicate case registration for variant ${entry.variantId}`,
        );
    }
    validateImplementationFiles(entry.implementationFiles, entry.variantId);
    registry.set(entry.variantId, entry);
}

export function builtinIncidentCaseRegistry(): IncidentCaseRegistry {
    const registry: IncidentCaseRegistry = new Map();
    for (const entry of [
        ...auditMemorySearchIncidentCases(),
        ...auditBackgroundLifecycleIncidentCases(),
        ...paritySyntheticTodoIncidentCases(),
        ...parityPiTodoIncidentCases(),
        ...sourceLinkedRegressionIncidentCases(),
    ]) {
        registerIncidentCase(registry, entry);
    }
    return registry;
}

/* */
export type SemanticContractInput = Pick<
    IncidentVariant,
    "lane" | "applicability" | "normative_checks" | "blocked_by"
>;

/**
 * semanticFingerprint canonicalizes normative checks, applicability, lane, prerequisites, and fixture meaning as JSON.
 */
export function semanticFingerprint(
    variant: SemanticContractInput,
    fixtures: Record<string, unknown>,
): string {
    return rowDigest({
        contract: SEMANTIC_FINGERPRINT_CONTRACT,
        lane: variant.lane,
        applicability: variant.applicability,
        normative_checks: variant.normative_checks,
        prerequisites: variant.blocked_by,
        fixtures,
    });
}

/** implementationBundleDigest hashes the bytes of the explicit root-confined implementation file list after sorting paths.
 * implementationBundleDigest ignores implementationFiles order but hashes exact file bytes. */
export function implementationBundleDigest(
    rootDir: string,
    files: string[],
): string {
    validateImplementationFiles(files, "bundle");
    const root = resolve(rootDir);
    const hash = createHash("sha256");
    hash.update(`${IMPLEMENTATION_BUNDLE_CONTRACT}\0`);
    for (const file of [...files].sort()) {
        const absolute = resolve(root, file);
        if (absolute !== root && !absolute.startsWith(root + sep)) {
            throw new Error(
                `implementation file ${file} escapes the declared root`,
            );
        }
        const bytes = readFileSync(absolute);
        hash.update(file);
        hash.update("\0");
        hash.update(String(bytes.length));
        hash.update("\0");
        hash.update(bytes);
    }
    return hash.digest("hex");
}

/** ledgerFingerprint hashes the full adjudication ledger line-exactly. */
export function ledgerFingerprint(
    adjudicationLines: readonly string[],
): string {
    return rowDigest([LEDGER_FINGERPRINT_CONTRACT, ...adjudicationLines]);
}

/**
 * Unregistered executable variants fail this validation.
 */
export function validateRegistryCatalogCorrespondence(
    registry: IncidentCaseRegistry,
    catalog: IncidentCatalog,
): void {
    const executableById = new Map<string, IncidentVariant>();
    for (const family of catalog.families) {
        for (const variant of family.variants) {
            if (!EXECUTABLE_LANES.includes(variant.lane)) continue;
            executableById.set(variant.id, variant);
        }
    }
    for (const [variantId, variant] of executableById) {
        if (variant.verifier_binding?.binding_status !== "live") {
            throw new Error(
                `executable variant ${variantId} requires a live catalog verifier binding`,
            );
        }
        if (!registry.has(variantId)) {
            throw new Error(
                `live executable variant ${variantId} has no registered case`,
            );
        }
    }
    for (const [variantId, registered] of registry) {
        const variant = executableById.get(variantId);
        if (!variant) {
            throw new Error(
                `registered case ${variantId} has no executable catalog variant`,
            );
        }
        const binding = variant.verifier_binding;
        if (!binding) {
            throw new Error(
                `registered case ${variantId} has no catalog verifier binding to satisfy`,
            );
        }
        const boundDriver = bindingName(registered.binding.driver);
        const boundVerifier = bindingName(registered.binding.verifier);
        const catalogDriver = bindingSymbol(binding.driver);
        const catalogVerifier = bindingSymbol(binding.verifier);
        if (boundDriver !== catalogDriver || boundVerifier !== catalogVerifier) {
            throw new Error(
                `registered case ${variantId} binds ${catalogDriver}/${catalogVerifier} but carries ${boundDriver || "<anonymous>"}/${boundVerifier || "<anonymous>"}`,
            );
        }
        // Validation requires `binding` to reference the `driver` and `verifier` that `run-incident-case.ts` executes.
        // Source-text scans cannot prove that a callback invokes its bound function.
        // something else.
        if (
            !executesBoundSymbol(registered.driver, registered.binding.driver) ||
            !executesBoundSymbol(
                registered.verifier,
                registered.binding.verifier,
            )
        ) {
            throw new Error(
                `registered case ${variantId} executes callbacks that are not bound to ${catalogDriver}/${catalogVerifier}`,
            );
        }
        const computed = semanticFingerprint(variant, registered.fixtures);
        if (computed !== variant.semantic_revision.fingerprint) {
            throw new Error(
                `variant ${variant.id} semantic fingerprint ${variant.semantic_revision.fingerprint} does not match the registered case (computed ${computed}); register a new semantic revision`,
            );
        }
    }
}

/* */
function bindingName(reference: unknown): string {
    if (typeof reference !== "function") return "";
    return reference.name;
}

/**
 */
const ADAPTED_FROM = Symbol.for("mc.incident-pool.adaptedFrom");

/**
 *
 *
 * The marker records the function passed to `adaptBoundSymbol`; it does not prove that the callback calls that function.
 * `build` can ignore `inner` and call an imported function while preserving its type.
 */
export function adaptBoundSymbol<I, F extends (...args: never[]) => unknown>(
    inner: I,
    build: (inner: I) => F,
): F {
    const adapted = build(inner);
    Object.defineProperty(adapted, ADAPTED_FROM, {
        value: inner,
        enumerable: false,
    });
    return adapted;
}

/* */
function executesBoundSymbol(executed: unknown, bound: unknown): boolean {
    if (typeof executed !== "function" || typeof bound !== "function")
        return false;
    if (executed === bound) return true;
    // SAFETY: `executed` is a function before the symbol-keyed property read.
    return (executed as unknown as Record<symbol, unknown>)[ADAPTED_FROM] ===
        bound;
}

/**
 */
function bindingSymbol(binding: string): string {
    const symbol = binding.split("#")[1] ?? "";
    return symbol.trim();
}
