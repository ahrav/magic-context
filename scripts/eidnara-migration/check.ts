import { readFileSync } from "node:fs";

export type CheckKind =
    | "migration-receipts"
    | "identity-allowlist"
    | "property-catalog"
    | "property-impact"
    | "architecture-impact";

type JsonObject = Record<string, unknown>;

const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{7,64}$/;
const LEGACY_IDENTITY_RE = /(?:cortexkit|magic-context|(?:^|[-_.])mc(?:$|[-_.])|(?:^|[-_.])ck(?:$|[-_.])|subc|MCTX)/i;

function isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value: unknown, path: string, errors: string[]): JsonObject | undefined {
    if (!isObject(value)) {
        errors.push(`${path} must be an object`);
        return undefined;
    }
    return value;
}

function requireString(
    object: JsonObject,
    key: string,
    path: string,
    errors: string[],
): string | undefined {
    const value = object[key];
    if (typeof value !== "string" || value.trim() === "") {
        errors.push(`${path}.${key} must be a non-empty string`);
        return undefined;
    }
    return value;
}

function requireBoolean(
    object: JsonObject,
    key: string,
    path: string,
    errors: string[],
): boolean | undefined {
    const value = object[key];
    if (typeof value !== "boolean") {
        errors.push(`${path}.${key} must be a boolean`);
        return undefined;
    }
    return value;
}

function requireArray(object: JsonObject, key: string, path: string, errors: string[]): unknown[] {
    const value = object[key];
    if (!Array.isArray(value)) {
        errors.push(`${path}.${key} must be an array`);
        return [];
    }
    return value;
}

function requireStringArray(
    object: JsonObject,
    key: string,
    path: string,
    errors: string[],
    minimum = 0,
): string[] {
    const values = requireArray(object, key, path, errors);
    const strings: string[] = [];
    values.forEach((value, index) => {
        if (typeof value !== "string" || value.trim() === "") {
            errors.push(`${path}.${key}[${index}] must be a non-empty string`);
        } else {
            strings.push(value);
        }
    });
    if (strings.length < minimum) {
        errors.push(`${path}.${key} must contain at least one entry`);
    }
    return strings;
}

function requireEnum(
    object: JsonObject,
    key: string,
    allowed: readonly string[],
    path: string,
    errors: string[],
): string | undefined {
    const value = requireString(object, key, path, errors);
    if (value !== undefined && !allowed.includes(value)) {
        errors.push(`${path}.${key} must be one of: ${allowed.join(", ")}`);
        return undefined;
    }
    return value;
}

function requireDigest(
    object: JsonObject,
    key: string,
    path: string,
    errors: string[],
): string | undefined {
    const value = requireString(object, key, path, errors);
    if (value !== undefined && !SHA256_RE.test(value)) {
        errors.push(`${path}.${key} must be a lowercase SHA-256 digest`);
        return undefined;
    }
    return value;
}

function requireCommit(
    object: JsonObject,
    key: string,
    path: string,
    errors: string[],
): string | undefined {
    const value = requireString(object, key, path, errors);
    if (value !== undefined && !COMMIT_RE.test(value)) {
        errors.push(`${path}.${key} must be a hexadecimal commit id`);
        return undefined;
    }
    return value;
}

function validateSchemaVersion(root: JsonObject, errors: string[]): void {
    if (root.schema_version !== 1) errors.push("$.schema_version must equal 1");
}

function validateRepoCommits(value: unknown, path: string, errors: string[]): void {
    if (!Array.isArray(value) || value.length === 0) {
        errors.push(`${path} must contain at least one repository commit`);
        return;
    }
    value.forEach((entry, index) => {
        const itemPath = `${path}[${index}]`;
        const item = requireObject(entry, itemPath, errors);
        if (item === undefined) return;
        requireString(item, "repo", itemPath, errors);
        requireCommit(item, "commit", itemPath, errors);
    });
}

function validateMigrationReceipt(root: JsonObject): string[] {
    const errors: string[] = [];
    validateSchemaVersion(root, errors);
    const wave = requireString(root, "wave", "$", errors);
    const sources = root.sources;
    if (wave === "U1" && Array.isArray(sources) && sources.length === 0) {
        // U1 authors destination control files and intentionally has no source repository.
    } else {
        validateRepoCommits(sources, "$.sources", errors);
    }
    validateRepoCommits(root.catalogs, "$.catalogs", errors);
    requireString(root, "property_impact", "$", errors);
    requireString(root, "architecture_impact", "$", errors);

    const destinations = new Set<string>();
    const files = requireArray(root, "files", "$", errors);
    if (files.length === 0) errors.push("$.files must contain at least one file");
    files.forEach((entry, index) => {
        const path = `$.files[${index}]`;
        const file = requireObject(entry, path, errors);
        if (file === undefined) return;
        const classification = requireEnum(
            file,
            "class",
            ["human-authored", "generated", "contract-generated", "new-authored"],
            path,
            errors,
        );
        const destination = requireString(file, "destination", path, errors);
        requireDigest(file, "sha256", path, errors);
        if (destination !== undefined) {
            if (destinations.has(destination)) errors.push(`${path}.destination is duplicated`);
            destinations.add(destination);
        }
        if (classification === "new-authored") {
            if (file.source !== null) errors.push(`${path}.source must be null for new-authored files`);
            requireString(file, "design_review", path, errors);
        } else {
            requireString(file, "source", path, errors);
        }
        if (classification === "human-authored") requireString(file, "doc_rigor", path, errors);
        if (classification === "contract-generated") {
            requireString(file, "generator", path, errors);
            requireString(file, "semantic_review", path, errors);
        }
    });

    const gates = requireObject(root.gates, "$.gates", errors);
    if (gates !== undefined) {
        if (Object.keys(gates).length === 0) {
            errors.push("$.gates must declare at least one blocking gate");
        }
        const allowed = ["pass", "fail", "cannot_run", "not_run"];
        for (const [name, value] of Object.entries(gates)) {
            if (typeof value !== "string" || !allowed.includes(value)) {
                errors.push(`$.gates.${name} must be one of: ${allowed.join(", ")}`);
                continue;
            }
            if (value !== "pass") {
                errors.push(`$.gates.${name} blocks the wave with status ${value}`);
            }
        }
    }
    if (root.known_red !== undefined) {
        const seen = new Set<string>();
        requireArray(root, "known_red", "$", errors).forEach((entry, index) => {
            const path = `$.known_red[${index}]`;
            const knownRed = requireObject(entry, path, errors);
            if (knownRed === undefined) return;
            const gate = requireString(knownRed, "gate", path, errors);
            requireEnum(
                knownRed,
                "kind",
                ["release", "parity", "architecture", "property", "other"],
                path,
                errors,
            );
            const kind = knownRed.kind;
            requireEnum(knownRed, "status", ["fail", "cannot_run", "not_run"], path, errors);
            requireString(knownRed, "justification", path, errors);
            if (kind === "architecture" || kind === "property") {
                errors.push(`${path}.kind is nonwaivable`);
            }
            if (gate !== undefined) {
                if (seen.has(gate)) errors.push(`${path}.gate is duplicated`);
                seen.add(gate);
                if (gates !== undefined && Object.hasOwn(gates, gate)) {
                    errors.push(`${path}.gate is also declared as a blocking gate`);
                }
            }
        });
    }
    return errors;
}

function validateIdentityAllowlist(root: JsonObject): string[] {
    const errors: string[] = [];
    validateSchemaVersion(root, errors);
    const seen = new Set<string>();
    const identities = requireArray(root, "identities", "$", errors);
    if (identities.length === 0) errors.push("$.identities must contain at least one identity");
    identities.forEach((entry, index) => {
        const path = `$.identities[${index}]`;
        const identity = requireObject(entry, path, errors);
        if (identity === undefined) return;
        const value = requireString(identity, "value", path, errors);
        const classification = requireEnum(
            identity,
            "class",
            ["renamed", "frozen-durable", "external-protocol", "third-party-coordinate"],
            path,
            errors,
        );
        requireString(identity, "rationale", path, errors);
        requireStringArray(identity, "evidence", path, errors, 1);
        if (value !== undefined) {
            if (seen.has(value)) errors.push(`${path}.value is duplicated`);
            seen.add(value);
            if (LEGACY_IDENTITY_RE.test(value) && classification === "renamed") {
                errors.push(`${path} retains a legacy identity but class is renamed`);
            }
        }
    });
    return errors;
}

function validatePropertyCatalog(root: JsonObject): string[] {
    const errors: string[] = [];
    validateSchemaVersion(root, errors);
    const seen = new Set<string>();
    const records = requireArray(root, "records", "$", errors);
    if (records.length === 0) errors.push("$.records must contain at least one property");
    records.forEach((entry, index) => {
        const path = `$.records[${index}]`;
        const record = requireObject(entry, path, errors);
        if (record === undefined) return;
        const slug = requireString(record, "slug", path, errors);
        const status = requireEnum(record, "status", ["active", "invalidated"], path, errors);
        requireEnum(
            record,
            "check_semantics",
            ["always", "always-or-unreached", "sometimes", "reachable", "unreachable"],
            path,
            errors,
        );
        requireString(record, "guarantee", path, errors);
        requireString(record, "exact_check", path, errors);
        requireStringArray(record, "evidence", path, errors, 1);
        requireStringArray(record, "required_faults", path, errors);
        requireStringArray(record, "enabling_states", path, errors);
        requireEnum(record, "relationship", ["mapped", "isolated"], path, errors);
        if (slug !== undefined) {
            if (seen.has(slug)) errors.push(`${path}.slug is duplicated`);
            seen.add(slug);
        }
        if (status === "active") {
            requireEnum(record, "exercised", ["yes", "partial", "not-yet"], path, errors);
            requireEnum(record, "check_status", ["audited", "unaudited", "none"], path, errors);
        } else if (status === "invalidated") {
            requireStringArray(record, "unreachability_evidence", path, errors, 1);
        }
    });
    return errors;
}

function validatePropertyImpact(root: JsonObject): string[] {
    const errors: string[] = [];
    validateSchemaVersion(root, errors);
    validateRepoCommits(root.provenance, "$.provenance", errors);
    requireCommit(root, "destination_commit", "$", errors);
    const touched = requireStringArray(root, "touched_files", "$", errors);
    if (touched.length === 0) errors.push("$.touched_files must contain at least one file");
    const covered = new Set<string>();
    const seen = new Set<string>();
    const records = requireArray(root, "records", "$", errors);
    if (records.length === 0) errors.push("$.records must contain at least one disposition");
    records.forEach((entry, index) => {
        const path = `$.records[${index}]`;
        const record = requireObject(entry, path, errors);
        if (record === undefined) return;
        const slug = requireString(record, "slug", path, errors);
        const classification = requireEnum(
            record,
            "classification",
            ["core", "excluded-dropped"],
            path,
            errors,
        );
        const disposition = requireEnum(record, "disposition", ["pass", "blocked"], path, errors);
        requireEnum(record, "relationship", ["mapped", "isolated"], path, errors);
        const files = requireStringArray(record, "files", path, errors);
        if (slug !== undefined) {
            if (seen.has(slug)) errors.push(`${path}.slug is duplicated`);
            seen.add(slug);
        }
        if (classification === "core") {
            files.forEach((file) => covered.add(file));
            requireString(record, "strategy_decision", path, errors);
            const auditVerdict = requireString(record, "audit_verdict", path, errors);
            requireDigest(record, "evidence_digest", path, errors);
            requireDigest(record, "code_hash", path, errors);
            requireDigest(record, "check_hash", path, errors);
            const targets = requireStringArray(record, "target_configurations", path, errors);
            if (disposition !== "pass") errors.push(`${path} blocks the wave`);
            if (auditVerdict !== undefined && auditVerdict !== "pass") {
                errors.push(`${path}.audit_verdict must equal pass`);
            }
            if (targets.length === 0) {
                errors.push(`${path}.target_configurations must contain at least one target`);
            }
        } else {
            requireString(record, "isolation_evidence", path, errors);
        }
    });
    for (const file of touched) {
        if (!covered.has(file)) errors.push(`$.touched_files has uncovered file: ${file}`);
    }
    return errors;
}

function validateArchitectureImpact(root: JsonObject): string[] {
    const errors: string[] = [];
    validateSchemaVersion(root, errors);
    const phases = new Set<string>();
    const reports = requireArray(root, "reports", "$", errors);
    reports.forEach((entry, reportIndex) => {
        const reportPath = `$.reports[${reportIndex}]`;
        const report = requireObject(entry, reportPath, errors);
        if (report === undefined) return;
        const phase = requireEnum(
            report,
            "phase",
            ["pre-port", "post-integration"],
            reportPath,
            errors,
        );
        if (phase !== undefined) {
            if (phases.has(phase)) errors.push(`${reportPath}.phase is duplicated`);
            phases.add(phase);
        }
        const analyzed = requireObject(report.analyzed, `${reportPath}.analyzed`, errors);
        if (analyzed !== undefined) {
            requireString(analyzed, "repo", `${reportPath}.analyzed`, errors);
            requireCommit(analyzed, "commit", `${reportPath}.analyzed`, errors);
            requireDigest(analyzed, "scope_hash", `${reportPath}.analyzed`, errors);
        }
        requireDigest(report, "report_hash", reportPath, errors);
        requireArray(report, "candidates", reportPath, errors).forEach((candidateEntry, index) => {
            const path = `${reportPath}.candidates[${index}]`;
            const candidate = requireObject(candidateEntry, path, errors);
            if (candidate === undefined) return;
            const strength = requireEnum(
                candidate,
                "strength",
                ["Strong", "Worth exploring", "Speculative"],
                path,
                errors,
            );
            const decision = requireEnum(
                candidate,
                "decision",
                ["accepted", "rejected", "recorded", "unresolved"],
                path,
                errors,
            );
            requireString(candidate, "title", path, errors);
            requireStringArray(candidate, "modules", path, errors);
            requireString(candidate, "interface", path, errors);
            requireString(candidate, "implementation", path, errors);
            const deletion = requireObject(candidate.deletion_test, `${path}.deletion_test`, errors);
            if (deletion !== undefined) {
                requireBoolean(deletion, "concentrates_complexity", `${path}.deletion_test`, errors);
                requireString(deletion, "rationale", `${path}.deletion_test`, errors);
            }
            const benefits = requireObject(candidate.benefits, `${path}.benefits`, errors);
            let hasBenefit = false;
            if (benefits !== undefined) {
                const flags = ["locality", "leverage", "testability"].map((key) =>
                    requireBoolean(benefits, key, `${path}.benefits`, errors),
                );
                hasBenefit = flags.some((flag) => flag === true);
            }
            const claimsFlexibility = requireBoolean(candidate, "claims_flexibility", path, errors);
            const adapters = requireStringArray(candidate, "adapters", path, errors);
            const routes = requireStringArray(candidate, "specialist_routes", path, errors);
            if (strength === "Strong" && decision !== "accepted" && decision !== "rejected") {
                errors.push(`${path} is a Strong candidate that is neither accepted nor rejected`);
            }
            if (decision === "accepted") {
                requireString(candidate, "final_verdict", path, errors);
                requireString(candidate, "implementation_evidence", path, errors);
                requireString(candidate, "property_impact", path, errors);
                requireStringArray(candidate, "affected_properties", path, errors, 1);
                if (routes.length === 0) {
                    errors.push(`${path}.specialist_routes must contain at least one route`);
                }
                if (!hasBenefit) {
                    errors.push(`${path} has no locality, leverage, or testability benefit`);
                }
                if (deletion?.concentrates_complexity !== true) {
                    errors.push(`${path} fails the deletion test`);
                }
            }
            if (decision === "rejected") requireString(candidate, "rationale", path, errors);
            if (claimsFlexibility === true && adapters.length < 2) {
                errors.push(`${path} claims flexibility without two current adapters`);
            }
        });
    });
    for (const phase of ["pre-port", "post-integration"]) {
        if (!phases.has(phase)) errors.push(`$.reports is missing ${phase} phase`);
    }
    return errors;
}

export function validate(kind: CheckKind, value: unknown): string[] {
    const rootErrors: string[] = [];
    const root = requireObject(value, "$", rootErrors);
    if (root === undefined) return rootErrors;
    switch (kind) {
        case "migration-receipts":
            return validateMigrationReceipt(root);
        case "identity-allowlist":
            return validateIdentityAllowlist(root);
        case "property-catalog":
            return validatePropertyCatalog(root);
        case "property-impact":
            return validatePropertyImpact(root);
        case "architecture-impact":
            return validateArchitectureImpact(root);
    }
}

export function run(argv: string[]): number {
    const [kind, path] = argv;
    const allowed: CheckKind[] = [
        "migration-receipts",
        "identity-allowlist",
        "property-catalog",
        "property-impact",
        "architecture-impact",
    ];
    if (!allowed.includes(kind as CheckKind) || path === undefined || argv.length !== 2) {
        console.error(`usage: bun scripts/eidnara-migration/check.ts <${allowed.join("|")}> <json-path>`);
        return 2;
    }
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (error) {
        console.error(`failed to read ${path}: ${String(error)}`);
        return 2;
    }
    const errors = validate(kind as CheckKind, value);
    if (errors.length > 0) {
        errors.forEach((error) => console.error(error));
        return 1;
    }
    console.log(`${kind}: PASS (${path})`);
    return 0;
}

if (import.meta.main) process.exit(run(process.argv.slice(2)));
