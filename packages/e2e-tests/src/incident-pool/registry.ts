/**
 * Executable-case registry and snapshot fingerprints (U2, KTD9, R5-R6).
 *
 * A registered case binds one executable semantic revision to a driver,
 * normalizer, pure verifier, explicit root-confined implementation file
 * list, and fixture bundle. Correspondence with the catalog is strictly 1:1.
 *
 * Fingerprints:
 *  - semanticFingerprint: canonical JSON over structured contract meaning
 *    (lane, applicability, normative checks, prerequisites, fixture meaning)
 *    — formatting- and key-order-insensitive.
 *  - implementationBundleDigest: byte-hash over the explicit file list —
 *    any source-byte change alters it.
 *  - ledgerFingerprint: hash over the full adjudication ledger lines.
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

/** Serializable observation data — the only shape a driver may return and
 *  the only shape a normalizer/verifier may consume. */
export type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [key: string]: JsonValue };
export type NormalizedObservation = JsonValue;

export interface VerifierCheck {
    /** Static check id declared in the variant's normative_checks. */
    id: string;
    passed: boolean;
}

export type PreconditionOutcome =
    | { satisfied: true }
    | {
          satisfied: false;
          reason: "blocked_by_dependency" | "precondition_unmet";
          /** Reviewed catalog dependencies when reason is blocked_by_dependency. */
          blockedBy: string[];
      };

export type PrerequisiteOutcome = { ok: true } | { ok: false; reason: string };

export interface RegisteredIncidentCase {
    variantId: string;
    /** Repo-root-relative driver/verifier/normalizer/fixture/dependency
     *  files byte-hashed into the implementation-bundle digest. */
    implementationFiles: string[];
    /** Structured fixture MEANING (not raw bytes) folded into the semantic
     *  fingerprint. */
    fixtures: Record<string, unknown>;
    /** Returns serializable observations or throws an infrastructure error. */
    driver(context: CaseDriverContext): Promise<JsonValue>;
    normalizer(raw: JsonValue): NormalizedObservation;
    /** Reproduction preconditions, validated BEFORE the behavioral verifier. */
    precondition(observation: NormalizedObservation): PreconditionOutcome;
    /** Pure verifier over the normalized observation. */
    verifier(observation: NormalizedObservation): VerifierCheck[];
    /** The exact module functions this case executes, carried as references
     *  so validation can bind them to the catalog's `file#symbol`
     *  verifier_binding names instead of trusting registration placement. */
    binding: { driver: unknown; verifier: unknown };
    /** Parent-side availability probe; a miss reports `unavailable`. */
    prerequisite?(): PrerequisiteOutcome;
}

export type IncidentCaseRegistry = Map<string, RegisteredIncidentCase>;

/** Reject absolute paths, parent escapes, and duplicates up front. */
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

/** The structured contract inputs that define one semantic revision. */
export type SemanticContractInput = Pick<
    IncidentVariant,
    "lane" | "applicability" | "normative_checks" | "blocked_by"
>;

/**
 * Canonical semantic fingerprint (KTD9): normative checks, applicability,
 * lane, prerequisites, and fixture meaning through canonical JSON, so
 * equivalent formatting or key order cannot change it.
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

/** Byte-hash of the explicit root-confined implementation file list. The
 *  listed order is irrelevant (paths are sorted); the bytes are not. */
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

/** Fingerprint of the full adjudication ledger (line-exact). */
export function ledgerFingerprint(
    adjudicationLines: readonly string[],
): string {
    return rowDigest([LEDGER_FINGERPRINT_CONTRACT, ...adjudicationLines]);
}

/**
 * Each registered case must name an executable catalog variant with a live
 * verifier binding, and its catalog semantic fingerprint must equal the
 * fingerprint recomputed from its fixtures. Unregistered executable
 * variants do not fail this validation.
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
        // Bind the registered functions to the catalog's named symbols: a
        // registration that wraps or swaps in another exported function from
        // the same module must fail here, not silently execute the wrong
        // oracle. Function identity is compared by the runtime `name` of the
        // carried reference, which matches the catalog symbol exactly for the
        // module-level declarations these bindings name.
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
        // The checks above validate `binding`, but `run-incident-case.ts`
        // executes `driver`/`verifier`. Nothing coupled the two, so a
        // registration could keep correct binding metadata while executing a
        // different oracle. The coupling is proved structurally: the executed
        // callback either IS the bound reference, or it was built by
        // `adaptBoundSymbol`, which records the function object it adapted.
        // Scanning the executed callback's source text cannot prove it, because
        // a wrapper that merely mentions the expected name in a comment, a dead
        // expression, or an unrelated identifier reads as bound while calling
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

/** Runtime name of a carried binding reference, for catalog comparison. */
function bindingName(reference: unknown): string {
    if (typeof reference !== "function") return "";
    return reference.name;
}

/**
 * The function object an adapted callback was built from, when it carries one.
 */
const ADAPTED_FROM = Symbol.for("mc.incident-pool.adaptedFrom");

/**
 * Build the callback the pool executes from the symbol the catalog binds.
 *
 * Some cases cannot register the bound symbol directly: the drivers take a
 * prepared harness rather than a `CaseDriverContext`, and the verifiers take a
 * normalized observation and return a richer record than `VerifierCheck[]`. The
 * adaptation is passed the bound reference and nothing else, so the callback it
 * returns is written against that function, and the reference is recorded on the
 * result for validation.
 *
 * This proves which function the registration is built from, not that the body
 * calls it — a `build` that ignores its argument and calls an imported impostor
 * still type-checks. That residual gap is visible at the registration site,
 * where the impostor has to be named; a source-text scan closed nothing at all,
 * because any mention of the expected identifier satisfied it.
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

/** Is `executed` the bound reference, or an adapter built from it? */
function executesBoundSymbol(executed: unknown, bound: unknown): boolean {
    if (typeof executed !== "function" || typeof bound !== "function")
        return false;
    if (executed === bound) return true;
    // SAFETY: function objects support symbol-keyed properties set by adaptBoundSymbol.
    return (executed as unknown as Record<symbol, unknown>)[ADAPTED_FROM] ===
        bound;
}

/**
 * The exported-symbol half of a catalog `path#symbol` binding string.
 */
function bindingSymbol(binding: string): string {
    const symbol = binding.split("#")[1] ?? "";
    return symbol.trim();
}
