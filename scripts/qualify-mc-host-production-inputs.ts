/**
 * U9 production-input and provider-credential qualifier (KTD7, KTD21, KTD23, R51).
 *
 * Generates, deterministically (stable key order, no timestamps, no environment
 * input), three byte-exact outputs:
 *
 *   - release/mc-host-production-inputs.lock.json      (immutable input lock)
 *   - release/mc-host-provider-credentials.json        (closed harness/provider matrix)
 *   - tmp/mc-host-release-qualification.json (local qualification evidence)
 *
 * Inputs:
 *   - The U8 pre-build release contract (scripts/generate-mc-host-release-manifest.ts).
 *     Every U9 artifact cites its canonical SHA-256 digest; a stale or edited
 *     committed contract fails closed.
 *   - release/mc-host-production-input-sources.json, the operator-populated source
 *     manifest describing the exact production artifact bytes (CPU ONNX Runtime,
 *     gte-modernbert-base-f16, tokenizer/config files, semantic corpus) plus the
 *     recorded offline semantic-oracle evidence. Real production bytes are not in
 *     this repository: entries release engineering has not qualified yet are
 *     explicitly `qualified: false`, which propagates to non-production evidence
 *     that `requireQualificationEvidence` (the U2/U6 build gate) rejects. No
 *     placeholder hash, committed tiny fixture, developer cache, or mutable URL
 *     can ever qualify.
 *
 * Usage:
 *   bun scripts/qualify-mc-host-production-inputs.ts          # write outputs
 *   bun scripts/qualify-mc-host-production-inputs.ts --check  # fail on any drift
 */

import { createHash } from "node:crypto";
import {
    closeSync,
    constants as fsConstants,
    existsSync,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
    buildContract,
    canonicalJson,
    type ReleaseContract,
    sha256Hex,
    validateContractSchema,
} from "./generate-mc-host-release-manifest";

// ---------------------------------------------------------------------------
// Paths.
// ---------------------------------------------------------------------------

export const SOURCE_MANIFEST_PATH =
    "release/mc-host-production-input-sources.json";

export const OUTPUT_PATHS = {
    lock: "release/mc-host-production-inputs.lock.json",
    credentials: "release/mc-host-provider-credentials.json",
    evidence: "tmp/mc-host-release-qualification.json",
    closureCatalog:
        "packages/plugin/src/shared/mc-host-lifecycle/generated-production-inputs.ts",
    closureCatalogRust: "release/generated/mc-host-harness-closures.rs",
} as const;

const RELEASE_CONTRACT_PATH = "release/mc-host-release.json";
const TINY_FIXTURE_MANIFEST_PATH =
    "crates/mc-host/tests/fixtures/synapse-tiny/manifest.json";
const BUN_LOCK_PATH = "bun.lock";
const MC_HOST_CARGO_TOML_PATH = "crates/mc-host/Cargo.toml";

function fail(message: string): never {
    throw new Error(`mc-host input qualification: ${message}`);
}

// ---------------------------------------------------------------------------
// U9 pins (cross-checked against the U8 contract; drift fails closed).
// ---------------------------------------------------------------------------

/** Exact production model/native-runtime identity already pinned in-repo
 *  (docs/synapse-model-bundle.md, crates/mc-host/Cargo.toml). */
export const RUNTIME_IDENTITY = {
    model: {
        id: "gte-modernbert-base-f16",
        execution_provider: "cpu",
        platforms: ["linux-x64-gnu"],
    },
    rust_crates: {
        fastembed: "6.0.0",
        ort: "2.0.0-rc.13",
        // Resolved ORT feature closure (docs/synapse-model-bundle.md §3). No
        // download, TLS/fetch, Hugging Face, image-model, or accelerator feature.
        ort_features: [
            "api-17",
            "api-18",
            "api-19",
            "api-20",
            "api-21",
            "api-22",
            "api-23",
            "api-24",
            "load-dynamic",
            "ndarray",
            "preload-dylibs",
            "std",
        ],
        ort_sys_features: ["disable-linking"],
    },
} as const;

/** Platform floors, harness runtimes, layout IDs, budgets, size limits, and
 *  durability scope. Floors/layouts are duplicated deliberately and asserted
 *  equal to the U8 contract, so either side drifting fails closed (R47, KTD23). */
export const QUALIFICATION_PINS = {
    platform_floors: {
        "darwin-arm64": { dev_fd_exec: true, os_min: "13.5" },
        "darwin-x64": { dev_fd_exec: true, os_min: "13.5" },
        "linux-x64-gnu": {
            glibc_min: "2.28",
            kernel_min: "4.18",
            procfs_self_fd_exec: true,
        },
    },
    harness_runtimes: { bun: "1.3.14", node: "24.18.0", npm: "11.x" },
    install_layouts: [
        "bun_physical_link",
        "compiled_bun_external",
        "npm_hoisted",
        "npm_nested",
    ],
    // Plan "Startup and storage budgets" table. p95 values are release-
    // qualification thresholds; hard values are runtime deadlines.
    cold_start_budgets_ms: {
        retained_transport: { p95: 2000, hard: 5000 },
        bootstrap_copy: { p95: 1000, hard: 3000 },
        macos_generation_stage: { p95: 3000, hard: 10000 },
        linux_generation_stage: { p95: 20000, hard: 45000 },
        spawn_publication_auth: { p95: 1000, hard: 3000 },
        fresh_macos_transport_aggregate: { p95: 5000, hard: 15000 },
        fresh_linux_transport_aggregate: { p95: 25000, hard: 60000 },
        storage_ready_post_publication: { p95: 2000, hard: 5000 },
        linux_synapse_certification_post_publication: {
            p95: 45000,
            hard: 90000,
        },
    },
    // Internal channel budgets with headroom (U6 enforces actuals against these).
    package_size_limits_bytes: {
        "@cortexkit/mc-host-darwin-arm64": {
            compressed_max: 62914560,
            unpacked_max: 157286400,
        },
        "@cortexkit/mc-host-darwin-x64": {
            compressed_max: 62914560,
            unpacked_max: 157286400,
        },
        "@cortexkit/mc-host-linux-x64-gnu": {
            compressed_max: 471859200,
            unpacked_max: 734003200,
        },
    },
    durability_scope: "process_crash_only",
} as const;

/** Assert the duplicated U9 pins agree with the U8 contract (fail on mismatch). */
export function assertPinsMatchContract(contract: ReleaseContract): void {
    for (const platform of contract.platforms.supported) {
        const pinned =
            QUALIFICATION_PINS.platform_floors[
                platform.target as keyof typeof QUALIFICATION_PINS.platform_floors
            ];
        if (pinned === undefined)
            fail(`no pinned floor for U8 platform ${platform.target}`);
        if ("kernel_min" in platform) {
            if (
                !("kernel_min" in pinned) ||
                pinned.kernel_min !== platform.kernel_min ||
                pinned.glibc_min !== platform.glibc_min ||
                pinned.procfs_self_fd_exec !==
                    platform.capabilities.procfs_self_fd_exec
            ) {
                fail(`linux floor pins disagree with the U8 contract`);
            }
        } else if (
            !("os_min" in pinned) ||
            pinned.os_min !== platform.os_min ||
            pinned.dev_fd_exec !== platform.capabilities.dev_fd_exec
        ) {
            fail(`${platform.target} floor pins disagree with the U8 contract`);
        }
    }
    if (
        Object.keys(QUALIFICATION_PINS.platform_floors).length !==
        contract.platforms.supported.length
    ) {
        fail("pinned floor targets disagree with the U8 contract");
    }
    if (
        JSON.stringify(QUALIFICATION_PINS.install_layouts) !==
        JSON.stringify(contract.install_layouts)
    ) {
        fail("pinned install layout IDs disagree with the U8 contract");
    }
    if (
        RUNTIME_IDENTITY.model.id !== contract.model_lane.id ||
        RUNTIME_IDENTITY.model.execution_provider !==
            contract.model_lane.execution_provider ||
        JSON.stringify(RUNTIME_IDENTITY.model.platforms) !==
            JSON.stringify(contract.model_lane.platforms)
    ) {
        fail("pinned model lane disagrees with the U8 contract");
    }
    const limitNames = Object.keys(
        QUALIFICATION_PINS.package_size_limits_bytes,
    ).sort();
    if (
        JSON.stringify(limitNames) !==
        JSON.stringify([...contract.packages.payloads].sort())
    ) {
        fail("package-size limits must cover exactly the U8 payload packages");
    }
    for (const [name, limit] of Object.entries(
        QUALIFICATION_PINS.package_size_limits_bytes,
    )) {
        if (
            !Number.isSafeInteger(limit.compressed_max) ||
            !Number.isSafeInteger(limit.unpacked_max) ||
            limit.compressed_max <= 0 ||
            limit.unpacked_max < limit.compressed_max
        ) {
            fail(`package-size limits for ${name} are not coherent`);
        }
    }
    for (const [name, budget] of Object.entries(
        QUALIFICATION_PINS.cold_start_budgets_ms,
    )) {
        if (
            !Number.isSafeInteger(budget.p95) ||
            !Number.isSafeInteger(budget.hard) ||
            budget.p95 <= 0 ||
            budget.hard < budget.p95
        ) {
            fail(`cold-start budget ${name} is not coherent (p95 <= hard)`);
        }
    }
}

// ---------------------------------------------------------------------------
// Provider-credential matrix, typed argument variants, and closure schema.
// ---------------------------------------------------------------------------

export const VALUE_CAP_BYTES = 16384;
export const ROW_CAP_BYTES = 65536;

const VARIABLE_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

const CREDENTIALS_DOC = {
    schema: "magic-context.mc-host-provider-credentials/v1",
    caps: {
        value_cap_bytes: VALUE_CAP_BYTES,
        row_cap_bytes: ROW_CAP_BYTES,
        // Individual value size is checked before aggregate row size (KTD21).
        individual_before_row: true,
        row_size_definition:
            "sum of UTF-8 byte lengths of every variable name and its value in the selected row",
    },
    // Connection-key-derived fingerprint identity. Pinned here so U2 and the
    // TypeScript client derive the identical protocol-internal fingerprint; the
    // fingerprint itself is never emitted, persisted, or rendered.
    fingerprint: {
        domain: "subc-broca-credential-v1",
        canonicalization: "harness-provider-name-length-value/1",
        encoding:
            "concatenation of length-prefixed UTF-8 fields `<decimal byte length>:<field>` in this exact order: the canonicalization tag, the harness id, the canonical provider id, then for each variable in row order its name, its value's decimal byte length, and its value; MACed with a key derived from the authenticated connection bearer under the pinned domain",
        emitted: false,
    },
    harnesses: {
        opencode: {
            package: "opencode-ai",
            argument_variants: {
                raw_argv_allowed: false,
                control_tokens: [
                    "--",
                    "--agent",
                    "--auth",
                    "--config",
                    "--continue",
                    "--cwd",
                    "--env",
                    "--extension",
                    "--hostname",
                    "--log-level",
                    "--mode",
                    "--model",
                    "--output",
                    "--port",
                    "--print-logs",
                    "--provider",
                    "--session",
                    "--share",
                    "--tool",
                    "--tools",
                ],
                variants: {
                    run_prompt: {
                        template: ["run", "--model", "{model}", "{prompt}"],
                        fields: {
                            model: {
                                position: 2,
                                pattern:
                                    "^[a-z0-9][a-z0-9-]*/[A-Za-z0-9][A-Za-z0-9._/-]*$",
                            },
                            prompt: { position: 3 },
                        },
                    },
                },
            },
            providers: {
                anthropic: {
                    mechanism: "direct_api_key",
                    credential_variables: ["ANTHROPIC_API_KEY"],
                },
                google: {
                    mechanism: "direct_api_key",
                    credential_variables: ["GEMINI_API_KEY"],
                },
                openai: {
                    mechanism: "direct_api_key",
                    credential_variables: ["OPENAI_API_KEY"],
                },
            },
            aliases: {},
        },
        pi: {
            package: "@earendil-works/pi-coding-agent",
            argument_variants: {
                raw_argv_allowed: false,
                control_tokens: [
                    "--",
                    "--api-key",
                    "--config",
                    "--continue",
                    "--cwd",
                    "--env",
                    "--extension",
                    "--import",
                    "--mode",
                    "--model",
                    "--models",
                    "--no-context-files",
                    "--no-extensions",
                    "--no-prompt-templates",
                    "--no-session",
                    "--no-skills",
                    "--output",
                    "--print",
                    "--provider",
                    "--require",
                    "--resume",
                    "--session",
                    "--tools",
                ],
                variants: {
                    run_prompt: {
                        template: [
                            "--print",
                            "--mode",
                            "json",
                            "--no-session",
                            "--no-skills",
                            "--no-prompt-templates",
                            "--no-context-files",
                            "--no-extensions",
                            "--model",
                            "{model}",
                            "{prompt}",
                        ],
                        fields: {
                            model: {
                                position: 9,
                                pattern:
                                    "^[a-z0-9][a-z0-9-]*/[A-Za-z0-9][A-Za-z0-9._/-]*$",
                            },
                            prompt: { position: 10 },
                        },
                    },
                },
            },
            providers: {
                anthropic: {
                    mechanism: "direct_api_key",
                    credential_variables: ["ANTHROPIC_API_KEY"],
                },
                google: {
                    mechanism: "direct_api_key",
                    credential_variables: ["GEMINI_API_KEY"],
                },
                openai: {
                    mechanism: "direct_api_key",
                    credential_variables: ["OPENAI_API_KEY"],
                },
            },
            // Pi alias-to-canonical fallback (harness-provider-map.ts). The alias's
            // own subscription mechanism is unsupported; a run naming the alias with
            // direct API keys selects only the canonical row.
            aliases: {
                "google-antigravity": {
                    canonical: "google",
                    alias_mechanism: "subscription_oauth",
                    alias_mechanism_supported: false,
                    fallback: "canonical_row",
                },
                "openai-codex": {
                    canonical: "openai",
                    alias_mechanism: "subscription_oauth",
                    alias_mechanism_supported: false,
                    fallback: "canonical_row",
                },
            },
        },
    },
    // Closed unsupported-mechanism union -> auth_mechanism_unsupported.
    unsupported_auth_mechanisms: [
        "ambient_credential_chain",
        "bedrock",
        "copilot",
        "file_credentials",
        "stored_auth",
        "subscription_oauth",
        "vertex_adc",
    ],
    unsupported_auth_reason: "auth_mechanism_unsupported",
    // Unknown/custom canonical providers and unknown aliases.
    unknown_provider_reason: "provider_unsupported",
    // No qualified row may name or depend on ambient host state.
    forbidden_variable_names: [
        "AWS_CONFIG_FILE",
        "AWS_PROFILE",
        "AWS_SHARED_CREDENTIALS_FILE",
        "BUN_INSTALL",
        "DYLD_INSERT_LIBRARIES",
        "DYLD_LIBRARY_PATH",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "HOME",
        "LD_AUDIT",
        "LD_LIBRARY_PATH",
        "LD_PRELOAD",
        "LOGNAME",
        "NODE_OPTIONS",
        "NODE_PATH",
        "NPM_TOKEN",
        "PATH",
        "PWD",
        "SHELL",
        "TMPDIR",
        "USER",
    ],
    forbidden_variable_prefixes: ["GIT_", "GPG_", "SSH_", "XDG_", "npm_"],
    forbidden_variable_suffixes: ["_PROXY", "_proxy"],
    // Every rejected descriptor/closure/argument/provider/auth/credential
    // condition binds to exactly one U8 harness_unavailable_reason.
    rejection_bindings: {
        descriptor_missing: "descriptor_absent",
        descriptor_identity_invalid: "descriptor_invalid",
        descriptor_revalidation_failed: "descriptor_invalid",
        closure_node_missing: "closure_incomplete",
        closure_node_unresolved: "closure_incomplete",
        argument_variant_unknown: "argument_variant_invalid",
        argument_field_missing: "argument_variant_invalid",
        argument_field_unknown: "argument_variant_invalid",
        argument_field_flag_like: "argument_variant_invalid",
        argument_field_control_conflict: "argument_variant_invalid",
        argument_raw_argv: "argument_variant_invalid",
        provider_unknown: "provider_unsupported",
        auth_mechanism_unsupported_requested: "auth_mechanism_unsupported",
        credential_absent_or_empty: "credential_missing",
        credential_value_over_cap: "credential_value_too_large",
        credential_row_over_cap: "credential_row_too_large",
        credential_fingerprint_mismatch: "credential_snapshot_mismatch",
    },
    // Closed harness runtime-closure manifest schema (KTD21). U2 materializes a
    // daemon-owned content-addressed closure matching this shape; runtime code
    // never discovers new dependencies.
    closure_manifest_schema: {
        id: "magic-context.mc-host-harness-closure/v1",
        closed: true,
        fields: [
            "argument_variant",
            "entrypoint",
            "executable",
            "extensions",
            "harness",
            "interpreter",
            "nodes",
            "package",
            "schema",
            "source_roots",
            "version",
        ],
        node: {
            fields: [
                "dependencies",
                "kind",
                "mode",
                "path",
                "sha256",
                "size_bytes",
                "source_path",
                "source_root",
            ],
            path_rules: ["relative", "no_parent_segments", "no_symlink_escape"],
        },
        dependency: {
            fields: ["kind", "path"],
            kinds: ["finite_dynamic", "native", "static"],
        },
        node_kinds: [
            "data",
            "executable",
            "extension",
            "interpreter",
            "module",
            "native_addon",
        ],
        extensions_ordered: true,
        rules: {
            finite_dynamic_imports_only: true,
            no_runtime_import_discovery: true,
            reachable_native_addons_required: true,
            relative_layout_preserved: true,
        },
    },
} as const;

export type CredentialsDoc = typeof CREDENTIALS_DOC;

/** Validators and evaluators accept values wider than CREDENTIALS_DOC's literal type. */
export interface CredentialsMatrix {
    caps: {
        value_cap_bytes: number;
        row_cap_bytes: number;
        individual_before_row: boolean;
        row_size_definition: string;
    };
    fingerprint: {
        domain: string;
        canonicalization: string;
        encoding: string;
        emitted: boolean;
    };
    harnesses: Record<
        string,
        {
            package: string;
            argument_variants: {
                raw_argv_allowed: boolean;
                control_tokens: readonly string[];
                variants: Record<
                    string,
                    {
                        template: readonly string[];
                        fields: Record<
                            string,
                            { position: number; pattern?: string }
                        >;
                    }
                >;
            };
            providers: Record<
                string,
                { mechanism: string; credential_variables: readonly string[] }
            >;
            aliases: Record<
                string,
                {
                    canonical: string;
                    alias_mechanism: string;
                    alias_mechanism_supported: boolean;
                    fallback: string;
                }
            >;
        }
    >;
    unsupported_auth_mechanisms: readonly string[];
    unsupported_auth_reason: string;
    unknown_provider_reason: string;
    forbidden_variable_names: readonly string[];
    forbidden_variable_prefixes: readonly string[];
    forbidden_variable_suffixes: readonly string[];
    rejection_bindings: Record<string, string>;
}

export function buildCredentialsDoc(): CredentialsMatrix {
    return CREDENTIALS_DOC;
}

function variableNameForbidden(doc: CredentialsMatrix, name: string): boolean {
    return (
        doc.forbidden_variable_names.includes(name) ||
        doc.forbidden_variable_prefixes.some((p) => name.startsWith(p)) ||
        doc.forbidden_variable_suffixes.some((s) => name.endsWith(s))
    );
}

/** Static validation of the credential matrix + U8 cross-checks. */
export function validateCredentialsDoc(
    doc: CredentialsMatrix,
    contract: ReleaseContract,
): void {
    if (
        doc.caps.value_cap_bytes !==
            contract.harness_unavailable.value_cap_bytes ||
        doc.caps.row_cap_bytes !== contract.harness_unavailable.row_cap_bytes
    ) {
        fail("credential caps disagree with the U8 contract");
    }
    if (doc.caps.individual_before_row !== true) {
        fail("individual-size precedence over row size is fixed");
    }
    if (
        doc.fingerprint.domain !== contract.credential_fingerprint.domain ||
        doc.fingerprint.canonicalization !==
            contract.credential_fingerprint.canonicalization ||
        doc.fingerprint.emitted !== false
    ) {
        fail("fingerprint identity disagrees with the U8 contract");
    }
    const contractReasons = contract.harness_unavailable.reasons_by_precedence
        .map((row) => row.id)
        .sort();
    const boundReasons = [
        ...new Set(Object.values(doc.rejection_bindings)),
    ].sort();
    if (JSON.stringify(boundReasons) !== JSON.stringify(contractReasons)) {
        fail(
            "rejection bindings must cover exactly the U8 harness_unavailable_reason union",
        );
    }
    if (doc.unsupported_auth_reason !== "auth_mechanism_unsupported")
        fail("unsupported auth mechanisms map to auth_mechanism_unsupported");
    if (doc.unknown_provider_reason !== "provider_unsupported")
        fail("unknown/custom providers map to provider_unsupported");
    for (const [harnessName, harness] of Object.entries(doc.harnesses)) {
        for (const [providerName, row] of Object.entries(harness.providers)) {
            if (row.mechanism !== "direct_api_key") {
                fail(
                    `${harnessName}/${providerName}: only direct API-key mechanisms may be qualified`,
                );
            }
            if (row.credential_variables.length === 0) {
                fail(`${harnessName}/${providerName}: empty credential row`);
            }
            const seen = new Set<string>();
            for (const name of row.credential_variables) {
                if (!VARIABLE_NAME_RE.test(name)) {
                    fail(
                        `${harnessName}/${providerName}: variable name ${JSON.stringify(name)} is not a plain env name (wildcards rejected)`,
                    );
                }
                if (variableNameForbidden(doc, name)) {
                    fail(
                        `${harnessName}/${providerName}: variable ${name} depends on forbidden ambient state`,
                    );
                }
                if (seen.has(name))
                    fail(
                        `${harnessName}/${providerName}: duplicate variable ${name}`,
                    );
                seen.add(name);
            }
        }
        for (const [aliasName, alias] of Object.entries(harness.aliases)) {
            if (
                !(alias.canonical in harness.providers) ||
                alias.alias_mechanism_supported !== false ||
                alias.fallback !== "canonical_row" ||
                !doc.unsupported_auth_mechanisms.includes(alias.alias_mechanism)
            ) {
                fail(
                    `${harnessName}: alias ${aliasName} must fall back to a qualified canonical row with an unsupported alias mechanism`,
                );
            }
        }
        const variants = harness.argument_variants;
        if (variants.raw_argv_allowed !== false)
            fail(`${harnessName}: raw appendable argv is forbidden`);
        for (const [variantName, variant] of Object.entries(
            variants.variants,
        )) {
            const fieldEntries = Object.entries(variant.fields);
            const placeholderPositions = new Map<string, number>();
            variant.template.forEach((token, index) => {
                if (token.startsWith("{") && token.endsWith("}")) {
                    placeholderPositions.set(token.slice(1, -1), index);
                }
            });
            if (placeholderPositions.size !== fieldEntries.length) {
                fail(
                    `${harnessName}/${variantName}: fields and template placeholders must correspond one-to-one`,
                );
            }
            for (const [fieldName, field] of fieldEntries) {
                if (placeholderPositions.get(fieldName) !== field.position) {
                    fail(
                        `${harnessName}/${variantName}: field ${fieldName} must map to one fixed template position`,
                    );
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Broca run evaluation (matrix consumer; used by tests and later by U2).
// ---------------------------------------------------------------------------

export type HarnessUnavailableReason =
    | "descriptor_absent"
    | "descriptor_invalid"
    | "closure_incomplete"
    | "argument_variant_invalid"
    | "provider_unsupported"
    | "auth_mechanism_unsupported"
    | "credential_missing"
    | "credential_value_too_large"
    | "credential_row_too_large"
    | "credential_snapshot_mismatch";

export interface BrocaRunRequest {
    harness: string;
    provider: string;
    /** Requested auth mechanism; defaults to direct_api_key. */
    mechanism?: string;
    /** Bounded captured credential source (names -> values). Values never
     *  leave this evaluation; only names/order are release data. */
    credentials: Record<string, string>;
}

export type BrocaRunEvaluation =
    | {
          ok: true;
          provider: string;
          variables: string[];
          viaAlias: string | null;
      }
    | { ok: false; reason: HarnessUnavailableReason };

function utf8Bytes(text: string): number {
    return Buffer.byteLength(text, "utf8");
}

/**
 * Evaluate one Broca run against the closed matrix, in the U8 precedence order:
 * provider row lookup (with Pi alias-to-canonical fallback), auth mechanism,
 * credential presence, individual value cap, then aggregate row cap.
 */
export function evaluateBrocaRun(
    doc: CredentialsMatrix,
    request: BrocaRunRequest,
): BrocaRunEvaluation {
    const harness = doc.harnesses[request.harness];
    if (harness === undefined)
        fail(`unknown harness ${JSON.stringify(request.harness)}`);
    let canonical = request.provider;
    let viaAlias: string | null = null;
    const alias = harness.aliases[request.provider];
    if (alias !== undefined) {
        canonical = alias.canonical;
        viaAlias = request.provider;
    }
    const row = harness.providers[canonical];
    if (row === undefined) return { ok: false, reason: "provider_unsupported" };
    const mechanism = request.mechanism ?? "direct_api_key";
    if (mechanism !== "direct_api_key") {
        return { ok: false, reason: "auth_mechanism_unsupported" };
    }
    let rowBytes = 0;
    // First pass: presence, then individual caps for every value, then row size —
    // individual-size precedence over aggregate row size (KTD21).
    for (const name of row.credential_variables) {
        const value = request.credentials[name];
        if (value === undefined || value === "") {
            return { ok: false, reason: "credential_missing" };
        }
    }
    for (const name of row.credential_variables) {
        const value = request.credentials[name];
        if (value === undefined) continue;
        if (utf8Bytes(value) > doc.caps.value_cap_bytes) {
            return { ok: false, reason: "credential_value_too_large" };
        }
        rowBytes += utf8Bytes(name) + utf8Bytes(value);
    }
    if (rowBytes > doc.caps.row_cap_bytes) {
        return { ok: false, reason: "credential_row_too_large" };
    }
    return {
        ok: true,
        provider: canonical,
        variables: [...row.credential_variables],
        viaAlias,
    };
}

/**
 * Canonical `(harness, provider, name, length, value)` row encoding backing the
 * connection-keyed fingerprint. Returns the pre-MAC message only; no fingerprint
 * is computed here and neither the message nor any value is ever emitted into a
 * release artifact.
 */
export function canonicalCredentialRowEncoding(
    harness: string,
    provider: string,
    entries: readonly (readonly [string, string])[],
): string {
    const enc = (field: string) => `${utf8Bytes(field)}:${field}`;
    let message =
        enc(CREDENTIALS_DOC.fingerprint.canonicalization) +
        enc(harness) +
        enc(provider);
    for (const [name, value] of entries) {
        message += enc(name) + enc(String(utf8Bytes(value))) + enc(value);
    }
    return message;
}

// ---------------------------------------------------------------------------
// Typed argument-variant rendering.
// ---------------------------------------------------------------------------

export type ArgumentVariantResult =
    | { ok: true; argv: string[] }
    | { ok: false; reason: "argument_variant_invalid"; detail: string };

/**
 * Render one exact fixed isolation argv from a typed variant. No raw appendable
 * argv exists; each typed field maps to one fixed host-owned template position.
 */
export function renderArgumentVariant(
    doc: CredentialsMatrix,
    harnessName: string,
    variantName: string,
    fields: Record<string, unknown>,
): ArgumentVariantResult {
    const invalid = (detail: string): ArgumentVariantResult => ({
        ok: false,
        reason: "argument_variant_invalid",
        detail,
    });
    const harness = doc.harnesses[harnessName];
    if (harness === undefined)
        fail(`unknown harness ${JSON.stringify(harnessName)}`);
    const spec = harness.argument_variants;
    const variant = spec.variants[variantName];
    if (variant === undefined) return invalid("unknown variant");
    const expected = Object.keys(variant.fields).sort();
    const actual = Object.keys(fields).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        return invalid(
            `fields must be exactly ${expected.join(", ")}; raw or extra argv is rejected`,
        );
    }
    const literals = new Set(
        variant.template.filter((token) => !token.startsWith("{")),
    );
    const argv = [...variant.template];
    for (const [name, field] of Object.entries(variant.fields)) {
        const value = fields[name];
        if (typeof value !== "string" || value.length === 0) {
            return invalid(`field ${name} must be a non-empty string`);
        }
        if (/[\0\r\n]/.test(value))
            return invalid(`field ${name} contains control bytes`);
        if (value === "--" || value.startsWith("-")) {
            return invalid(`field ${name} parses as a flag`);
        }
        if (
            literals.has(value) ||
            (spec.control_tokens as readonly string[]).includes(value)
        ) {
            return invalid(`field ${name} duplicates a host-owned control`);
        }
        if (
            field.pattern !== undefined &&
            !new RegExp(field.pattern).test(value)
        ) {
            return invalid(`field ${name} fails its pattern`);
        }
        argv[field.position] = value;
    }
    return { ok: true, argv };
}

// ---------------------------------------------------------------------------
// Source-manifest schema and byte verification.
// ---------------------------------------------------------------------------

export const INPUT_KEYS = [
    "bundle_manifest",
    "config",
    "corpus",
    "model_onnx",
    "ort_runtime",
    "special_tokens_map",
    "tokenizer",
    "tokenizer_config",
] as const;

const APPROVED_SPDX = ["Apache-2.0", "MIT"] as const;
const PRODUCTION_LICENSE_APPROVERS = [
    "mc-host U9 SPDX allowlist",
] as const;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MUTABLE_SOURCE_PATTERNS = [
    "/main/",
    "/master/",
    "/latest/",
    "/HEAD/",
    "/nightly/",
];
const FIXTURE_OR_CACHE_PATH_PATTERNS = [
    "synapse-tiny",
    "tests/fixtures",
    "node_modules",
    "/.cache/",
    "/.bun/",
    "/target/",
];

export const HARNESS_CLOSURE_SCHEMA =
    "magic-context.mc-host-harness-closure/v1";

const QUALIFIED_NONLITERAL_DYNAMIC_IMPORT_SITES: ReadonlyMap<
    string,
    {
        sha256: string;
        expressions: readonly string[];
        mode: "finite" | "builtin" | "unsupported_provider" | "host_extension";
        targets: readonly string[];
    }
> = new Map([
    [
        "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/bedrock-converse-stream.lazy.js",
        {
            sha256: "fc0052380edeeb83d148d89030ed47762bebde39f25f71c6632a1a883c7ab8fd",
            expressions: [
                "import(__rewriteRelativeImportExtension(runtimeSpecifier))",
            ],
            mode: "unsupported_provider",
            targets: ["./bedrock-converse-stream.js"],
        },
    ],
    [
        "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js",
        {
            sha256: "0333478c984f786afe17e6a22d3da8bcf0528f83dccfcdf8e28abb071aae4a37",
            expressions: [
                "import(__rewriteRelativeImportExtension(specifier))",
            ],
            mode: "builtin",
            targets: ["node:os"],
        },
    ],
    [
        "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/auth/context.js",
        {
            sha256: "5d0ea91a2fd2acf84e3b9717ce59e75006933c68d8efa91873894a9d963d41a0",
            expressions: [
                "import(__rewriteRelativeImportExtension(specifier))",
            ],
            mode: "builtin",
            targets: ["node:fs/promises", "node:os"],
        },
    ],
    [
        "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/env-api-keys.js",
        {
            sha256: "102c2b8622b18c8fc3e1f961e5cc2a6c83104a85c5d693f08e419a05d99beaac",
            expressions: [
                "import(__rewriteRelativeImportExtension(specifier))",
            ],
            mode: "builtin",
            targets: ["node:fs", "node:os", "node:path"],
        },
    ],
    [
        "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/oauth/load.js",
        {
            sha256: "235f9498265ebd02edfce4d4ec6a5542892fc17e300700a19eeefee5219929a7",
            expressions: [
                "import(__rewriteRelativeImportExtension(runtimeSpecifier))",
            ],
            mode: "finite",
            targets: [
                "./anthropic.js",
                "./github-copilot.js",
                "./openai-codex.js",
            ],
        },
    ],
    [
        "node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-static.mjs",
        {
            sha256: "0d873b8be0c9e08e1136ea428175de8cf8a200c67b6b83283a009b3f46ff4a3a",
            expressions: ["import(id)"],
            mode: "host_extension",
            targets: [
                "embedded:pi-broca-extension:16814ddc9b0578e0f53cdf324d4624066b1e59d5c33276d2590d937a2a601b3a",
            ],
        },
    ],
]);

export const HARNESS_CLOSURE_NODE_KINDS = [
    "data",
    "executable",
    "extension",
    "interpreter",
    "module",
    "native_addon",
] as const;

export const HARNESS_CLOSURE_DEPENDENCY_KINDS = [
    "finite_dynamic",
    "native",
    "static",
] as const;

export type HarnessClosureName = "opencode" | "pi";
export type HarnessClosureNodeKind =
    (typeof HARNESS_CLOSURE_NODE_KINDS)[number];
export type HarnessClosureDependencyKind =
    (typeof HARNESS_CLOSURE_DEPENDENCY_KINDS)[number];

export interface HarnessClosureDependency {
    path: string;
    kind: HarnessClosureDependencyKind;
}

export interface HarnessClosureNode {
    path: string;
    source_root: string;
    source_path: string;
    kind: HarnessClosureNodeKind;
    mode: number;
    size_bytes: number;
    sha256: string;
    dependencies: HarnessClosureDependency[];
}

export interface HarnessClosureManifest {
    schema: typeof HARNESS_CLOSURE_SCHEMA;
    harness: HarnessClosureName;
    package: string;
    version: string;
    argument_variant: string;
    source_roots: string[];
    executable: string | null;
    interpreter: string | null;
    entrypoint: string | null;
    extensions: string[];
    nodes: HarnessClosureNode[];
}

interface HarnessSource {
    package: string;
    version: string | null;
    unqualified_reason?: string;
    closure?: HarnessClosureManifest;
    closure_manifest?: {
        path: string;
        sha256: string;
    };
    closure_platforms?: string[];
    closure_verify_roots?: Record<string, string>;
    closure_unqualified_reason?: string;
}

interface QualifiedArtifact {
    qualified: true;
    source: string;
    size_bytes: number;
    sha256: string;
    provenance: string;
    license: {
        spdx: string;
        redistribution_approved: boolean;
        approved_by: string;
    };
    verify_local_path: string;
}

interface UnqualifiedArtifact {
    qualified: false;
    reason: string;
}

type ArtifactSource = QualifiedArtifact | UnqualifiedArtifact;

export interface OracleEvidence {
    model_fingerprint: string;
    table_epoch: number;
    execution_provider: string;
    host: {
        target: string;
        kernel: string;
        glibc: string;
        exact_floor: boolean;
    };
    expected_vectors: number;
    tolerance: number;
    network_access: string;
    smoke_report: {
        path: string;
        sha256: string;
    };
}

interface SynapseSmokeReport {
    schema: "magic-context.mc-host-synapse-smoke/v1";
    mode: "production";
    model_fingerprint: string;
    table_epoch: number;
    execution_provider: string;
    host: OracleEvidence["host"];
    inputs: Record<"ort_runtime" | "model_onnx" | "bundle_manifest" | "semantic_corpus", string>;
    observed_vectors: number;
    max_abs_error: number;
    tolerance: number;
    operations: string[];
    restart_fenced: boolean;
    degraded_isolated: boolean;
    durable_receipts: boolean;
    network_access: string;
}

export interface SourceManifest {
    schema: string;
    mode: "production" | "test-fixture";
    note?: string;
    release_version: string;
    inputs: Record<(typeof INPUT_KEYS)[number], ArtifactSource>;
    oracle: OracleEvidence | null;
    harnesses: {
        opencode: HarnessSource;
        pi: HarnessSource;
    };
}

function assertExactKeys(
    obj: unknown,
    keys: string[],
    where: string,
    optional: string[] = [],
): void {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
        fail(`${where} must be an object`);
    }
    // SAFETY: `obj` is a non-null, non-array object after the guard.
    const record = obj as Record<string, unknown>;
    const actual = Object.keys(record);
    for (const key of actual) {
        if (!keys.includes(key) && !optional.includes(key)) {
            fail(`${where}: unknown key ${key}`);
        }
    }
    for (const key of keys) {
        if (!(key in record)) fail(`${where}: missing key ${key}`);
    }
}

export function isPlaceholderSha256(hash: string): boolean {
    return /^(.)\1{63}$/.test(hash);
}

function assertSafeRelativePath(value: unknown, where: string): asserts value is string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.startsWith("/") ||
        value.endsWith("/") ||
        value.includes("\\") ||
        value.includes("\0")
    ) {
        fail(`${where} must be a safe relative POSIX path`);
    }
    const segments = value.split("/");
    if (
        segments.some(
            (segment) =>
                segment.length === 0 || segment === "." || segment === "..",
        )
    ) {
        fail(`${where} must be a safe relative POSIX path without dot segments`);
    }
}

function assertNullableSafeRelativePath(
    value: unknown,
    where: string,
): asserts value is string | null {
    if (value !== null) assertSafeRelativePath(value, where);
}

function assertSortedUnique(
    values: readonly string[],
    where: string,
): void {
    for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        if (index > 0 && values[index - 1] >= value) {
            fail(`${where} must be sorted and unique`);
        }
    }
}

function expectedHarnessPackage(harness: HarnessClosureName): string {
    return CREDENTIALS_DOC.harnesses[harness].package;
}

/**
 * Validate one closed, content-addressable harness closure graph.
 *
 * The graph is sorted to make its identity reproducible. Extension order is
 * intentionally semantic and is therefore preserved rather than sorted.
 */
export function validateClosureManifest(
    manifest: unknown,
    expected?: {
        harness: HarnessClosureName;
        package: string;
        version: string;
    },
): asserts manifest is HarnessClosureManifest {
    assertExactKeys(
        manifest,
        [
            "schema",
            "harness",
            "package",
            "version",
            "argument_variant",
            "source_roots",
            "executable",
            "interpreter",
            "entrypoint",
            "extensions",
            "nodes",
        ],
        "closure",
    );
    const closure = manifest as HarnessClosureManifest;
    if (closure.schema !== HARNESS_CLOSURE_SCHEMA) {
        fail("closure: unknown schema");
    }
    if (closure.harness !== "opencode" && closure.harness !== "pi") {
        fail("closure: harness must be opencode or pi");
    }
    if (closure.package !== expectedHarnessPackage(closure.harness)) {
        fail(
            `closure: package must be ${expectedHarnessPackage(closure.harness)} for ${closure.harness}`,
        );
    }
    if (!/^\d+\.\d+\.\d+$/.test(closure.version)) {
        fail("closure: version must be exact semver");
    }
    const variants =
        CREDENTIALS_DOC.harnesses[closure.harness].argument_variants.variants;
    if (!(closure.argument_variant in variants)) {
        fail(
            `closure: argument_variant ${JSON.stringify(closure.argument_variant)} is not qualified for ${closure.harness}`,
        );
    }
    if (expected !== undefined) {
        if (
            closure.harness !== expected.harness ||
            closure.package !== expected.package ||
            closure.version !== expected.version
        ) {
            fail("closure: identity does not match its harness source record");
        }
    }

    if (
        !Array.isArray(closure.source_roots) ||
        closure.source_roots.length === 0
    ) {
        fail("closure.source_roots must be a non-empty array");
    }
    for (const [index, root] of closure.source_roots.entries()) {
        if (
            typeof root !== "string" ||
            !/^[a-z][a-z0-9_-]*$/.test(root)
        ) {
            fail(
                `closure.source_roots[${index}] must be a lowercase source-root id`,
            );
        }
    }
    assertSortedUnique(closure.source_roots, "closure.source_roots");

    assertNullableSafeRelativePath(closure.executable, "closure.executable");
    assertNullableSafeRelativePath(closure.interpreter, "closure.interpreter");
    assertNullableSafeRelativePath(closure.entrypoint, "closure.entrypoint");
    if (!Array.isArray(closure.extensions)) {
        fail("closure.extensions must be an array");
    }
    const extensionSet = new Set<string>();
    for (const [index, extension] of closure.extensions.entries()) {
        assertSafeRelativePath(extension, `closure.extensions[${index}]`);
        if (extensionSet.has(extension)) {
            fail("closure.extensions must be unique while preserving order");
        }
        extensionSet.add(extension);
    }

    if (!Array.isArray(closure.nodes) || closure.nodes.length === 0) {
        fail("closure.nodes must be a non-empty array");
    }
    const nodes = new Map<string, HarnessClosureNode>();
    for (const [index, node] of closure.nodes.entries()) {
        const where = `closure.nodes[${index}]`;
        assertExactKeys(
            node,
            [
                "path",
                "source_root",
                "source_path",
                "kind",
                "mode",
                "size_bytes",
                "sha256",
                "dependencies",
            ],
            where,
        );
        assertSafeRelativePath(node.path, `${where}.path`);
        assertSafeRelativePath(node.source_path, `${where}.source_path`);
        if (!closure.source_roots.includes(node.source_root)) {
            fail(`${where}.source_root does not name a declared source root`);
        }
        if (
            !(HARNESS_CLOSURE_NODE_KINDS as readonly unknown[]).includes(
                node.kind,
            )
        ) {
            fail(`${where}.kind is not a qualified node kind`);
        }
        const expectedMode =
            node.kind === "executable" || node.kind === "interpreter"
                ? 0o700
                : 0o600;
        if (node.mode !== expectedMode) {
            fail(`${where}.mode must be owner-only ${expectedMode.toString(8)}`);
        }
        if (
            !Number.isSafeInteger(node.size_bytes) ||
            node.size_bytes < 0
        ) {
            fail(`${where}.size_bytes must be a non-negative integer`);
        }
        if (
            typeof node.sha256 !== "string" ||
            !SHA256_RE.test(node.sha256) ||
            isPlaceholderSha256(node.sha256)
        ) {
            fail(`${where}.sha256 must be a real 64-lowercase-hex digest`);
        }
        if (!Array.isArray(node.dependencies)) {
            fail(`${where}.dependencies must be an array`);
        }
        const dependencyKeys: string[] = [];
        const dependencyPaths = new Set<string>();
        for (const [dependencyIndex, dependency] of node.dependencies.entries()) {
            const dependencyWhere = `${where}.dependencies[${dependencyIndex}]`;
            assertExactKeys(dependency, ["path", "kind"], dependencyWhere);
            assertSafeRelativePath(dependency.path, `${dependencyWhere}.path`);
            if (
                !(
                    HARNESS_CLOSURE_DEPENDENCY_KINDS as readonly unknown[]
                ).includes(dependency.kind)
            ) {
                fail(`${dependencyWhere}.kind is not a qualified dependency kind`);
            }
            if (dependencyPaths.has(dependency.path)) {
                fail(`${where}.dependencies must name each target once`);
            }
            dependencyPaths.add(dependency.path);
            dependencyKeys.push(`${dependency.path}\0${dependency.kind}`);
        }
        assertSortedUnique(dependencyKeys, `${where}.dependencies`);
        if (nodes.has(node.path)) {
            fail("closure.nodes paths must be unique");
        }
        nodes.set(node.path, node);
    }
    assertSortedUnique(
        closure.nodes.map((node) => node.path),
        "closure.nodes",
    );

    const requiredRoots: [string, string | null, HarnessClosureNodeKind][] = [];
    if (closure.harness === "opencode") {
        if (
            closure.executable === null ||
            closure.interpreter !== null ||
            closure.entrypoint !== null ||
            closure.extensions.length !== 0
        ) {
            fail(
                "closure: opencode requires only one executable root and no extensions",
            );
        }
        requiredRoots.push(["executable", closure.executable, "executable"]);
    } else {
        if (
            closure.executable !== null ||
            closure.interpreter === null ||
            closure.entrypoint === null
        ) {
            fail(
                "closure: pi requires interpreter and entrypoint roots without an executable root",
            );
        }
        requiredRoots.push(
            ["interpreter", closure.interpreter, "interpreter"],
            ["entrypoint", closure.entrypoint, "module"],
        );
        for (const extension of closure.extensions) {
            requiredRoots.push(["extension", extension, "extension"]);
        }
    }

    const reachable = new Set<string>();
    const pending: string[] = [];
    for (const [label, path, kind] of requiredRoots) {
        const node = path === null ? undefined : nodes.get(path);
        if (node === undefined) {
            fail(`closure: ${label} root ${JSON.stringify(path)} is missing`);
        }
        if (node.kind !== kind) {
            fail(`closure: ${label} root must have node kind ${kind}`);
        }
        if (
            (kind === "executable" || kind === "interpreter") &&
            (node.mode & 0o111) === 0
        ) {
            fail(`closure: ${label} root must have an executable mode`);
        }
        pending.push(node.path);
    }

    const nativeTargets = new Set<string>();
    while (pending.length > 0) {
        const path = pending.pop();
        if (path === undefined || reachable.has(path)) continue;
        reachable.add(path);
        const node = nodes.get(path);
        if (node === undefined) {
            fail(`closure: dependency target ${JSON.stringify(path)} is missing`);
        }
        for (const dependency of node.dependencies) {
            const target = nodes.get(dependency.path);
            if (target === undefined) {
                fail(
                    `closure: dependency target ${JSON.stringify(dependency.path)} is missing`,
                );
            }
            if (
                (dependency.kind === "native") !==
                (target.kind === "native_addon")
            ) {
                fail(
                    `closure: native dependency kind must correspond exactly to a native_addon target`,
                );
            }
            if (dependency.kind === "native") {
                nativeTargets.add(dependency.path);
            }
            pending.push(dependency.path);
        }
    }
    for (const node of closure.nodes) {
        if (!reachable.has(node.path)) {
            fail(`closure: node ${JSON.stringify(node.path)} is unreachable`);
        }
        if (
            node.kind === "native_addon" &&
            !nativeTargets.has(node.path)
        ) {
            fail(
                `closure: native addon ${JSON.stringify(node.path)} lacks an explicit native dependency edge`,
            );
        }
    }
}

/** Canonical bytes used as the content-addressed closure identity. */
export function canonicalClosureManifest(
    manifest: HarnessClosureManifest,
): string {
    return canonicalJson(manifest);
}

/** Deterministic SHA-256 over the canonical closure manifest bytes. */
export function closureManifestDigest(
    manifest: HarnessClosureManifest,
): string {
    return sha256Hex(canonicalClosureManifest(manifest));
}

function rustRawString(value: string): string {
    for (let hashes = 1; hashes <= 32; hashes += 1) {
        const fence = "#".repeat(hashes);
        if (!value.includes(`"${fence}`)) {
            return `r${fence}"${value}"${fence}`;
        }
    }
    fail("closure manifest cannot be represented as a bounded Rust raw string");
}

/** Recursively collect every 64-hex value from the committed tiny fixture
 *  manifest so no tiny-fixture artifact byte identity can ever qualify. */
function tinyFixtureHashBlacklist(rootDir: string): Set<string> {
    const blacklist = new Set<string>();
    const path = join(rootDir, TINY_FIXTURE_MANIFEST_PATH);
    if (!existsSync(path)) return blacklist;
    const collect = (value: unknown): void => {
        if (typeof value === "string") {
            if (SHA256_RE.test(value)) blacklist.add(value);
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value) collect(item);
            return;
        }
        if (value !== null && typeof value === "object") {
            for (const item of Object.values(value)) collect(item);
        }
    };
    try {
        collect(JSON.parse(readFileSync(path, "utf8")));
    } catch {
        fail(
            `unreadable tiny-fixture manifest at ${TINY_FIXTURE_MANIFEST_PATH}`,
        );
    }
    return blacklist;
}

function validateQualifiedArtifact(
    key: string,
    artifact: QualifiedArtifact,
    mode: SourceManifest["mode"],
    blacklist: Set<string>,
): void {
    assertExactKeys(
        artifact,
        [
            "qualified",
            "source",
            "size_bytes",
            "sha256",
            "provenance",
            "license",
            "verify_local_path",
        ],
        `inputs.${key}`,
    );
    if (typeof artifact.source !== "string") {
        fail(`inputs.${key}: source must be an immutable artifact identity`);
    }
    const contentAddress = artifact.source.match(/^urn:sha256:([0-9a-f]{64})$/);
    if (contentAddress !== null) {
        if (contentAddress[1] !== artifact.sha256) {
            fail(`inputs.${key}: content-addressed source disagrees with sha256`);
        }
    } else {
        if (!artifact.source.startsWith("https://") || artifact.source.endsWith("/")) {
            fail(
                `inputs.${key}: source must be an immutable https URL or urn:sha256 identity`,
            );
        }
        for (const pattern of MUTABLE_SOURCE_PATTERNS) {
            if (artifact.source.includes(pattern)) {
                fail(
                    `inputs.${key}: mutable source identity (${pattern.replaceAll("/", "")} ref) is rejected`,
                );
            }
        }
    }
    if (
        !Number.isSafeInteger(artifact.size_bytes) ||
        artifact.size_bytes <= 0
    ) {
        fail(`inputs.${key}: size_bytes must be a positive integer`);
    }
    if (
        typeof artifact.sha256 !== "string" ||
        !SHA256_RE.test(artifact.sha256)
    ) {
        fail(`inputs.${key}: sha256 must be 64 lowercase hex`);
    }
    if (isPlaceholderSha256(artifact.sha256)) {
        fail(`inputs.${key}: placeholder hash is rejected`);
    }
    if (blacklist.has(artifact.sha256)) {
        fail(
            `inputs.${key}: committed tiny fixture bytes can never qualify as production inputs`,
        );
    }
    if (
        typeof artifact.provenance !== "string" ||
        artifact.provenance.length === 0
    ) {
        fail(`inputs.${key}: provenance is required`);
    }
    const license = artifact.license;
    assertExactKeys(
        license,
        ["spdx", "redistribution_approved", "approved_by"],
        `inputs.${key}.license`,
    );
    if (!(APPROVED_SPDX as readonly string[]).includes(license.spdx)) {
        fail(
            `inputs.${key}: license ${JSON.stringify(license.spdx)} is not an approved redistribution license`,
        );
    }
    if (license.redistribution_approved !== true) {
        fail(`inputs.${key}: redistribution approval is required`);
    }
    if (
        typeof license.approved_by !== "string" ||
        license.approved_by.length === 0
    ) {
        fail(`inputs.${key}: license approval must name an approver`);
    }
    if (
        mode === "production" &&
        !(PRODUCTION_LICENSE_APPROVERS as readonly string[]).includes(
            license.approved_by,
        )
    ) {
        fail(`inputs.${key}: license approver is not a production policy`);
    }
    const verifyPath = artifact.verify_local_path;
    if (typeof verifyPath !== "string" || verifyPath.length === 0) {
        fail(`inputs.${key}: qualified entries must verify real local bytes`);
    }
    if (verifyPath.startsWith("~")) {
        fail(`inputs.${key}: home-relative verify path is rejected`);
    }
    for (const pattern of FIXTURE_OR_CACHE_PATH_PATTERNS) {
        if (verifyPath.includes(pattern)) {
            fail(
                `inputs.${key}: fixture/developer-cache verify path (${pattern}) is rejected`,
            );
        }
    }
    if (mode === "production" && !isAbsolute(verifyPath)) {
        fail(
            `inputs.${key}: production qualification requires an absolute verify path`,
        );
    }
}

export function checkOracleEvidence(
    oracle: OracleEvidence,
    contract: ReleaseContract,
    report: SynapseSmokeReport,
    inputs: SourceManifest["inputs"],
): void {
    assertExactKeys(
        oracle,
        [
            "model_fingerprint",
            "table_epoch",
            "execution_provider",
            "host",
            "expected_vectors",
            "tolerance",
            "network_access",
            "smoke_report",
        ],
        "oracle",
    );
    if (
        typeof oracle.model_fingerprint !== "string" ||
        !SHA256_RE.test(oracle.model_fingerprint) ||
        isPlaceholderSha256(oracle.model_fingerprint)
    ) {
        fail("oracle: model fingerprint must be a real 64-hex digest");
    }
    if (!Number.isSafeInteger(oracle.table_epoch) || oracle.table_epoch < 1) {
        fail("oracle: table_epoch must be a positive integer");
    }
    if (oracle.execution_provider !== contract.model_lane.execution_provider) {
        fail(
            `oracle: execution provider must be ${contract.model_lane.execution_provider}`,
        );
    }
    const linux = contract.platforms.supported.find(
        (p) => p.target === "linux-x64-gnu",
    );
    if (linux === undefined || !("kernel_min" in linux))
        fail("oracle: U8 contract lacks the linux floor");
    if (oracle.host?.target !== "linux-x64-gnu") {
        fail("oracle: the offline oracle must run on the linux-x64-gnu lane");
    }
    const versionAtLeast = (value: unknown, floor: string): boolean => {
        if (typeof value !== "string" || !/^\d+\.\d+$/.test(value))
            return false;
        const [a, b] = value.split(".").map(Number);
        const [fa, fb] = floor.split(".").map(Number);
        return a > fa || (a === fa && b >= fb);
    };
    if (
        !versionAtLeast(oracle.host.kernel, linux.kernel_min) ||
        !versionAtLeast(oracle.host.glibc, linux.glibc_min)
    ) {
        fail("oracle: host must meet the exact minimum Linux floor");
    }
    if (typeof oracle.host.exact_floor !== "boolean") {
        fail("oracle: host exact_floor must be boolean");
    }
    if (
        oracle.host.exact_floor &&
        (oracle.host.kernel !== linux.kernel_min ||
            oracle.host.glibc !== linux.glibc_min)
    ) {
        fail("oracle: exact-floor evidence must name the exact Linux floor");
    }
    if (
        !Number.isSafeInteger(oracle.expected_vectors) ||
        oracle.expected_vectors < 1
    ) {
        fail("oracle: expected_vectors must be a positive integer");
    }
    if (
        typeof oracle.tolerance !== "number" ||
        !Number.isFinite(oracle.tolerance) ||
        oracle.tolerance <= 0 ||
        oracle.tolerance > 0.1
    ) {
        fail("oracle: tolerance must be finite in (0, 0.1]");
    }
    if (oracle.network_access !== "none" && oracle.network_access !== "available") {
        fail("oracle: recorded network access must be none or available");
    }
    assertExactKeys(oracle.smoke_report, ["path", "sha256"], "oracle.smoke_report");
    assertSafeRelativePath(oracle.smoke_report.path, "oracle.smoke_report.path");
    if (
        !SHA256_RE.test(oracle.smoke_report.sha256) ||
        isPlaceholderSha256(oracle.smoke_report.sha256)
    ) {
        fail("oracle: smoke report must carry a real SHA-256");
    }
    assertExactKeys(
        report,
        [
            "schema",
            "mode",
            "model_fingerprint",
            "table_epoch",
            "execution_provider",
            "host",
            "inputs",
            "observed_vectors",
            "max_abs_error",
            "tolerance",
            "operations",
            "restart_fenced",
            "degraded_isolated",
            "durable_receipts",
            "network_access",
        ],
        "oracle smoke report",
    );
    if (
        report.schema !== "magic-context.mc-host-synapse-smoke/v1" ||
        report.mode !== "production"
    ) {
        fail("oracle: smoke report schema or mode is invalid");
    }
    if (
        report.model_fingerprint !== oracle.model_fingerprint ||
        report.table_epoch !== oracle.table_epoch ||
        report.execution_provider !== oracle.execution_provider ||
        canonicalJson(report.host) !== canonicalJson(oracle.host)
    ) {
        fail("oracle: smoke report identity or host does not match the source manifest");
    }
    assertExactKeys(
        report.inputs,
        ["ort_runtime", "model_onnx", "bundle_manifest", "semantic_corpus"],
        "oracle smoke report inputs",
    );
    for (const [reportKey, inputKey] of [
        ["ort_runtime", "ort_runtime"],
        ["model_onnx", "model_onnx"],
        ["bundle_manifest", "bundle_manifest"],
        ["semantic_corpus", "corpus"],
    ] as const) {
        const artifact = inputs[inputKey];
        if (
            artifact.qualified !== true ||
            report.inputs[reportKey] !== artifact.sha256
        ) {
            fail(`oracle: smoke report input ${reportKey} does not match the locked artifact`);
        }
    }
    if (
        report.observed_vectors !== oracle.expected_vectors ||
        report.tolerance !== oracle.tolerance ||
        typeof report.max_abs_error !== "number" ||
        !Number.isFinite(report.max_abs_error) ||
        report.max_abs_error < 0 ||
        report.max_abs_error > oracle.tolerance
    ) {
        fail("oracle: smoke report vector observations exceed the pinned oracle");
    }
    if (
        canonicalJson(report.operations) !==
            canonicalJson(["embed.batch", "embed.query", "embed.result", "models.list"]) ||
        report.restart_fenced !== true ||
        report.degraded_isolated !== true ||
        report.durable_receipts !== true ||
        report.network_access !== oracle.network_access
    ) {
        fail("oracle: smoke report does not prove the complete offline lifecycle");
    }
}

function readOracleSmokeReport(
    rootDir: string,
    oracle: OracleEvidence,
): SynapseSmokeReport {
    const reportPath = join(rootDir, oracle.smoke_report.path);
    let bytes: Buffer;
    try {
        bytes = readFileSync(reportPath);
    } catch {
        fail("oracle: smoke report is missing");
    }
    if (createHash("sha256").update(bytes).digest("hex") !== oracle.smoke_report.sha256) {
        fail("oracle: smoke report digest mismatch");
    }
    try {
        return JSON.parse(bytes.toString("utf8")) as SynapseSmokeReport;
    } catch {
        fail("oracle: smoke report is malformed JSON");
    }
}

function verifyClosureSourceBytes(
    rootDir: string,
    harness: HarnessClosureName,
    closure: HarnessClosureManifest,
    roots: Record<string, string> | undefined,
    mode: SourceManifest["mode"],
): void {
    if (roots === undefined) {
        if (mode === "production") {
            fail(`harnesses.${harness}: qualified closure requires closure_verify_roots`);
        }
        return;
    }
    const expectedRoots = [...closure.source_roots].sort();
    const actualRoots = Object.keys(roots).sort();
    if (JSON.stringify(expectedRoots) !== JSON.stringify(actualRoots)) {
        fail(`harnesses.${harness}: closure verify roots do not match the manifest`);
    }
    const openedRoots = new Map<string, string>();
    for (const rootName of expectedRoots) {
        const configured = roots[rootName];
        if (typeof configured !== "string" || configured.length === 0) {
            fail(`harnesses.${harness}: closure verify root is invalid`);
        }
        const root = isAbsolute(configured) ? configured : join(rootDir, configured);
        if (mode === "production" && !isAbsolute(configured)) {
            fail(`harnesses.${harness}: production closure verify roots must be absolute`);
        }
        let stat: ReturnType<typeof lstatSync>;
        try {
            stat = lstatSync(root);
        } catch {
            fail(`harnesses.${harness}: closure verify root is missing`);
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            fail(`harnesses.${harness}: closure verify root is not a physical directory`);
        }
        openedRoots.set(rootName, root);
    }

    for (const node of closure.nodes) {
        const root = openedRoots.get(node.source_root);
        if (root === undefined) {
            fail(`harnesses.${harness}: closure node source root is missing`);
        }
        let current = root;
        for (const component of node.source_path.split("/")) {
            current = join(current, component);
            let stat: ReturnType<typeof lstatSync>;
            try {
                stat = lstatSync(current);
            } catch {
                fail(`harnesses.${harness}: closure source node is missing`);
            }
            if (stat.isSymbolicLink()) {
                fail(`harnesses.${harness}: closure source node follows a symlink`);
            }
        }
        let fd: number;
        try {
            fd = openSync(
                current,
                fsConstants.O_RDONLY |
                    fsConstants.O_NOFOLLOW |
                    fsConstants.O_NONBLOCK,
            );
        } catch {
            fail(`harnesses.${harness}: closure source node cannot be opened`);
        }
        try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.size !== node.size_bytes) {
                fail(`harnesses.${harness}: closure source node size changed`);
            }
            const bytes = readFileSync(fd);
            const digest = createHash("sha256").update(bytes).digest("hex");
            if (digest !== node.sha256) {
                fail(`harnesses.${harness}: closure source node hash changed`);
            }
            if (
                node.kind === "module" &&
                /\.(?:c|m)?js$/.test(node.source_path)
            ) {
                validateQualifiedDynamicImports(
                    rootDir,
                    closure,
                    node,
                    harness,
                    node.source_path,
                    node.sha256,
                    bytes.toString("utf8"),
                );
            }
        } finally {
            closeSync(fd);
        }
    }
}

export function validateQualifiedDynamicImports(
    rootDir: string,
    closure: HarnessClosureManifest,
    node: HarnessClosureNode,
    harness: HarnessClosureName,
    sourcePath: string,
    sourceSha256: string,
    source: string,
): void {
    const file = ts.createSourceFile(
        sourcePath,
        source,
        ts.ScriptTarget.ESNext,
        false,
        ts.ScriptKind.JS,
    );
    const unresolved: string[] = [];
    const visit = (node: ts.Node): void => {
        const argument = ts.isCallExpression(node)
            ? node.arguments[0]
            : undefined;
        if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            (node.arguments.length !== 1 ||
                argument === undefined ||
                !ts.isStringLiteralLike(argument))
        ) {
            unresolved.push(node.getText(file));
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    if (unresolved.length === 0) return;
    const policy = QUALIFIED_NONLITERAL_DYNAMIC_IMPORT_SITES.get(sourcePath);
    if (
        harness !== "pi" ||
        policy === undefined ||
        policy.sha256 !== sourceSha256 ||
        JSON.stringify([...unresolved].sort()) !==
            JSON.stringify([...policy.expressions].sort())
    ) {
        fail(
            `harnesses.${harness}: closure module contains an unresolved dynamic import`,
        );
    }
    const finiteEdges = node.dependencies
        .filter((dependency) => dependency.kind === "finite_dynamic")
        .map((dependency) => dependency.path)
        .sort();
    if (policy.mode === "finite") {
        const targets = policy.targets
            .map((target) =>
                posix.normalize(posix.join(posix.dirname(sourcePath), target)),
            )
            .sort();
        if (
            JSON.stringify(finiteEdges) !== JSON.stringify(targets) ||
            targets.some(
                (target) =>
                    !closure.nodes.some((candidate) => candidate.path === target),
            )
        ) {
            fail(
                `harnesses.${harness}: finite dynamic import targets are not closed by graph edges`,
            );
        }
    } else if (finiteEdges.length !== 0) {
        fail(
            `harnesses.${harness}: non-finite dynamic import policy carries graph edges`,
        );
    } else if (policy.mode === "builtin") {
        if (!policy.targets.every((target) => target.startsWith("node:"))) {
            fail(`harnesses.${harness}: builtin import policy is invalid`);
        }
    } else if (policy.mode === "unsupported_provider") {
        if (
            "amazon-bedrock" in
            CREDENTIALS_DOC.harnesses.pi.providers
        ) {
            fail(`harnesses.${harness}: unsupported provider became qualified`);
        }
    } else {
        const hook = readFileSync(
            join(rootDir, "crates/mc-host/assets/pi-broca-extension.mjs"),
        );
        const target =
            `embedded:pi-broca-extension:${createHash("sha256").update(hook).digest("hex")}`;
        if (policy.targets.length !== 1 || policy.targets[0] !== target) {
            fail(`harnesses.${harness}: host extension import identity drifted`);
        }
    }
}

export function validateSourceManifest(
    manifest: unknown,
    contract: ReleaseContract,
    rootDir: string,
    verifyExternalBytes: boolean = true,
): asserts manifest is SourceManifest {
    if (manifest === null || typeof manifest !== "object") {
        fail("source manifest must be an object");
    }
    const m = manifest as SourceManifest;
    assertExactKeys(
        m,
        ["schema", "mode", "release_version", "inputs", "oracle", "harnesses"],
        "source manifest",
        ["note"],
    );
    if (m.schema !== "magic-context.mc-host-production-input-sources/v1") {
        fail("unknown source manifest schema");
    }
    if (m.mode !== "production" && m.mode !== "test-fixture") {
        fail("source manifest mode must be production or test-fixture");
    }
    if (m.release_version !== contract.release.version) {
        fail(
            `source manifest release_version ${m.release_version} does not match the U8 contract ${contract.release.version}`,
        );
    }
    const blacklist = tinyFixtureHashBlacklist(rootDir);
    assertExactKeys(m.inputs, [...INPUT_KEYS], "inputs");
    for (const key of INPUT_KEYS) {
        const artifact = m.inputs[key];
        if (artifact === null || typeof artifact !== "object") {
            fail(`inputs.${key} must be an object`);
        }
        if (artifact.qualified === true) {
            validateQualifiedArtifact(key, artifact, m.mode, blacklist);
        } else if (artifact.qualified === false) {
            if (
                typeof artifact.reason !== "string" ||
                artifact.reason.length === 0
            ) {
                fail(`inputs.${key}: unqualified entries must state a reason`);
            }
            assertExactKeys(artifact, ["qualified", "reason"], `inputs.${key}`);
        } else {
            fail(`inputs.${key}: qualified must be true or false`);
        }
    }
    if (m.oracle !== null) {
        const report = readOracleSmokeReport(rootDir, m.oracle);
        checkOracleEvidence(m.oracle, contract, report, m.inputs);
    }
    assertExactKeys(m.harnesses, ["opencode", "pi"], "harnesses");
    const expectPackage = {
        opencode: CREDENTIALS_DOC.harnesses.opencode.package,
        pi: CREDENTIALS_DOC.harnesses.pi.package,
    } as const;
    for (const name of ["opencode", "pi"] as const) {
        const harness = m.harnesses[name];
        assertExactKeys(harness, ["package", "version"], `harnesses.${name}`, [
            "unqualified_reason",
            "closure",
            "closure_manifest",
            "closure_platforms",
            "closure_verify_roots",
            "closure_unqualified_reason",
        ]);
        if (harness.package !== expectPackage[name]) {
            fail(`harnesses.${name}: package must be ${expectPackage[name]}`);
        }
        if (harness.version === null) {
            if (
                typeof harness.unqualified_reason !== "string" ||
                harness.unqualified_reason.length === 0
            ) {
                fail(
                    `harnesses.${name}: an unqualified version must state a reason`,
                );
            }
            if (harness.closure !== undefined) {
                fail(
                    `harnesses.${name}: an unqualified version cannot carry a closure`,
                );
            }
        } else if (
            typeof harness.version !== "string" ||
            !/^\d+\.\d+\.\d+$/.test(harness.version)
        ) {
            fail(`harnesses.${name}: version must be exact semver or null`);
        } else {
            if (harness.closure !== undefined && harness.closure_manifest !== undefined) {
                fail(`harnesses.${name}: closure must be inline or file-backed, not both`);
            }
            if (harness.closure_manifest !== undefined) {
                assertExactKeys(
                    harness.closure_manifest,
                    ["path", "sha256"],
                    `harnesses.${name}.closure_manifest`,
                );
                assertSafeRelativePath(
                    harness.closure_manifest.path,
                    `harnesses.${name}.closure_manifest.path`,
                );
                if (
                    !harness.closure_manifest.path.startsWith(
                        "release/mc-host-harness-closures/",
                    )
                ) {
                    fail(
                        `harnesses.${name}: closure manifest must live under release/mc-host-harness-closures`,
                    );
                }
                if (!SHA256_RE.test(harness.closure_manifest.sha256)) {
                    fail(`harnesses.${name}: closure manifest file sha256 is invalid`);
                }
                const closurePath = join(rootDir, harness.closure_manifest.path);
                if (!existsSync(closurePath)) {
                    fail(`harnesses.${name}: closure manifest file is missing`);
                }
                const bytes = readFileSync(closurePath);
                if (
                    createHash("sha256").update(bytes).digest("hex") !==
                    harness.closure_manifest.sha256
                ) {
                    fail(`harnesses.${name}: closure manifest file sha256 changed`);
                }
                try {
                    harness.closure = JSON.parse(bytes.toString("utf8")) as HarnessClosureManifest;
                } catch {
                    fail(`harnesses.${name}: closure manifest file is malformed`);
                }
            }
            if (harness.closure !== undefined) {
            if (harness.closure_unqualified_reason !== undefined) {
                fail(
                    `harnesses.${name}: qualified closure cannot carry an unqualified reason`,
                );
            }
            validateClosureManifest(harness.closure, {
                harness: name,
                package: harness.package,
                version: harness.version,
            });
            if (
                m.mode === "production" &&
                (!Array.isArray(harness.closure_platforms) ||
                    harness.closure_platforms.length === 0)
            ) {
                fail(`harnesses.${name}: qualified closure requires closure_platforms`);
            }
            if (harness.closure_platforms !== undefined) {
                assertSortedUnique(
                    harness.closure_platforms,
                    `harnesses.${name}.closure_platforms`,
                );
                for (const platform of harness.closure_platforms) {
                    if (!["linux-x64-gnu", "darwin-arm64", "darwin-x64"].includes(platform)) {
                        fail(`harnesses.${name}: unsupported closure platform ${platform}`);
                    }
                }
            }
            if (verifyExternalBytes) {
                verifyClosureSourceBytes(
                    rootDir,
                    name,
                    harness.closure,
                    harness.closure_verify_roots,
                    m.mode,
                );
            }
            } else if (m.mode === "production") {
            if (
                typeof harness.closure_unqualified_reason !== "string" ||
                harness.closure_unqualified_reason.length === 0
            ) {
                fail(
                    `harnesses.${name}: production source without a closure must state closure_unqualified_reason`,
                );
            }
            }
        }
    }
}

function verifyArtifactBytes(
    rootDir: string,
    key: string,
    artifact: QualifiedArtifact,
): void {
    const path = isAbsolute(artifact.verify_local_path)
        ? artifact.verify_local_path
        : join(rootDir, artifact.verify_local_path);
    if (!existsSync(path)) {
        fail(
            `inputs.${key}: verify bytes missing at ${artifact.verify_local_path}`,
        );
    }
    const bytes = readFileSync(path);
    if (bytes.length !== artifact.size_bytes) {
        fail(
            `inputs.${key}: byte size ${bytes.length} does not match locked size ${artifact.size_bytes}`,
        );
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== artifact.sha256) {
        fail(
            `inputs.${key}: byte digest does not match the locked sha256 (input bytes changed)`,
        );
    }
}

/** Repo-pinned identity cross-checks (bun.lock harness versions, Cargo crate pins). */
function crossCheckRepoPins(rootDir: string, manifest: SourceManifest): void {
    const bunLockPath = join(rootDir, BUN_LOCK_PATH);
    const piVersion = manifest.harnesses.pi.version;
    if (piVersion !== null) {
        if (!existsSync(bunLockPath)) {
            fail("bun.lock is required to qualify the exact Pi version");
        }
        const bunLock = readFileSync(bunLockPath, "utf8");
        if (
            !bunLock.includes(`"${manifest.harnesses.pi.package}@${piVersion}"`)
        ) {
            fail(
                `harnesses.pi: version ${piVersion} does not match the resolved bun.lock pin`,
            );
        }
    }
    const cargoPath = join(rootDir, MC_HOST_CARGO_TOML_PATH);
    if (manifest.mode === "production") {
        if (!existsSync(cargoPath)) {
            fail(
                "crates/mc-host/Cargo.toml is required to qualify the ORT crate pins",
            );
        }
        const cargo = readFileSync(cargoPath, "utf8");
        if (
            !cargo.includes(
                `fastembed = { version = "=${RUNTIME_IDENTITY.rust_crates.fastembed}"`,
            ) ||
            !cargo.includes(
                `ort = { version = "=${RUNTIME_IDENTITY.rust_crates.ort}"`,
            )
        ) {
            fail(
                "pinned fastembed/ort crate identities do not match crates/mc-host/Cargo.toml",
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Lock, credentials, and evidence construction.
// ---------------------------------------------------------------------------

function buildLock(
    manifest: SourceManifest,
    contract: ReleaseContract,
    u8Digest: string,
): { lock: Record<string, unknown>; unqualified: string[] } {
    const unqualified: string[] = [];
    const inputs: Record<string, unknown> = {};
    for (const key of INPUT_KEYS) {
        const artifact = manifest.inputs[key];
        if (artifact.qualified) {
            // Names, order, and source identities only — never credential or byte values.
            inputs[key] = {
                qualified: true,
                source: artifact.source,
                size_bytes: artifact.size_bytes,
                sha256: artifact.sha256,
                provenance: artifact.provenance,
                license: artifact.license,
            };
        } else {
            inputs[key] = { qualified: false, reason: artifact.reason };
            unqualified.push(`inputs.${key}: ${artifact.reason}`);
        }
    }
    let oracle: unknown;
    if (manifest.oracle === null) {
        const reason =
            "offline semantic-oracle evidence not yet recorded against real locked ORT/model bytes";
        oracle = { qualified: false, reason };
        unqualified.push(`oracle: ${reason}`);
    } else if (manifest.oracle.network_access !== "none") {
        const reason =
            "offline semantic oracle ran with network access available";
        oracle = { qualified: false, reason, observed: manifest.oracle };
        unqualified.push(`oracle: ${reason}`);
    } else if (!manifest.oracle.host.exact_floor) {
        const reason =
            "offline semantic oracle passed above the kernel floor; exact kernel 4.18 evidence has not run";
        oracle = { qualified: false, reason, observed: manifest.oracle };
        unqualified.push(`oracle: ${reason}`);
    } else {
        oracle = { qualified: true, ...manifest.oracle };
    }
    const harnesses: Record<string, unknown> = {};
    for (const name of ["opencode", "pi"] as const) {
        const harness = manifest.harnesses[name];
        if (harness.version === null) {
            const reason = harness.unqualified_reason as string;
            harnesses[name] = {
                package: harness.package,
                version: { qualified: false, reason },
            };
            unqualified.push(`harnesses.${name}: ${reason}`);
        } else {
            const closure =
                harness.closure === undefined
                    ? {
                          qualified: false,
                          reason: harness.closure_unqualified_reason as string,
                      }
                    : {
                          qualified: true,
                          sha256: closureManifestDigest(harness.closure),
                          source_roots: harness.closure.source_roots,
                          platforms: harness.closure_platforms,
                          ...(harness.closure_manifest === undefined
                              ? {}
                              : {
                                    manifest_path:
                                        harness.closure_manifest.path,
                                }),
                      };
            if (harness.closure === undefined) {
                unqualified.push(
                    `harnesses.${name}.closure: ${harness.closure_unqualified_reason as string}`,
                );
            }
            harnesses[name] = {
                package: harness.package,
                version: harness.version,
                closure,
            };
        }
    }
    unqualified.sort();
    const lock = {
        schema: "magic-context.mc-host-production-inputs-lock/v1",
        release: { id: contract.release.id, version: contract.release.version },
        release_contract_sha256: u8Digest,
        mode: manifest.mode,
        model_lane: RUNTIME_IDENTITY.model,
        rust_runtime: RUNTIME_IDENTITY.rust_crates,
        inputs,
        oracle,
        harnesses,
        harness_runtimes: QUALIFICATION_PINS.harness_runtimes,
        platform_floors: QUALIFICATION_PINS.platform_floors,
        install_layouts: QUALIFICATION_PINS.install_layouts,
        cold_start_budgets_ms: QUALIFICATION_PINS.cold_start_budgets_ms,
        package_size_limits_bytes: QUALIFICATION_PINS.package_size_limits_bytes,
        durability_scope: QUALIFICATION_PINS.durability_scope,
        production_qualified:
            manifest.mode === "production" && unqualified.length === 0,
        unqualified,
    };
    return { lock, unqualified };
}

// ---------------------------------------------------------------------------
// Generation and drift check.
// ---------------------------------------------------------------------------

export interface QualifyResult {
    u8Digest: string;
    lockSha256: string;
    credentialsSha256: string;
    productionQualified: boolean;
    drift: string[];
    outputs: Record<keyof typeof OUTPUT_PATHS, string>;
}

export function generate(
    rootDir: string,
    options: { check: boolean; verifyExternalBytes?: boolean },
): QualifyResult {
    const contract = buildContract();
    validateContractSchema(contract);
    assertPinsMatchContract(contract);
    validateCredentialsDoc(CREDENTIALS_DOC, contract);

    // Stale-U8 detection: the committed contract JSON must be byte-identical to
    // a clean regeneration of the in-source contract literal.
    const canonicalContract = canonicalJson(contract);
    const u8Digest = sha256Hex(canonicalContract);
    const contractPath = join(rootDir, RELEASE_CONTRACT_PATH);
    if (!existsSync(contractPath)) {
        fail(`missing U8 release contract at ${RELEASE_CONTRACT_PATH}`);
    }
    if (readFileSync(contractPath, "utf8") !== `${canonicalContract}\n`) {
        fail(
            `stale or edited U8 release contract at ${RELEASE_CONTRACT_PATH}; regenerate U8 first`,
        );
    }

    const manifestPath = join(rootDir, SOURCE_MANIFEST_PATH);
    if (!existsSync(manifestPath)) {
        fail(`missing source manifest at ${SOURCE_MANIFEST_PATH}`);
    }
    let manifestRaw: unknown;
    try {
        manifestRaw = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
        fail(
            `unreadable or malformed ${SOURCE_MANIFEST_PATH}: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    const verifyExternalBytes = options.verifyExternalBytes ?? !options.check;
    validateSourceManifest(manifestRaw, contract, rootDir, verifyExternalBytes);
    const manifest = manifestRaw;
    for (const key of INPUT_KEYS) {
        const artifact = manifest.inputs[key];
        if (artifact.qualified && verifyExternalBytes) {
            verifyArtifactBytes(rootDir, key, artifact);
        }
    }
    crossCheckRepoPins(rootDir, manifest);

    const { lock, unqualified } = buildLock(manifest, contract, u8Digest);
    const lockText = `${canonicalJson(lock)}\n`;
    const lockSha256 = sha256Hex(lockText);

    const credentials = {
        ...CREDENTIALS_DOC,
        release: { id: contract.release.id, version: contract.release.version },
        release_contract_sha256: u8Digest,
    };
    const credentialsText = `${canonicalJson(credentials)}\n`;
    const credentialsSha256 = sha256Hex(credentialsText);

    const productionQualified =
        manifest.mode === "production" && unqualified.length === 0;
    const evidence = {
        schema: "magic-context.mc-host-release-qualification/v1",
        release: { id: contract.release.id, version: contract.release.version },
        release_contract_sha256: u8Digest,
        artifacts: {
            production_inputs_lock: {
                path: OUTPUT_PATHS.lock,
                sha256: lockSha256,
            },
            provider_credentials: {
                path: OUTPUT_PATHS.credentials,
                sha256: credentialsSha256,
            },
        },
        production_qualified: productionQualified,
        test_only: manifest.mode !== "production",
        unqualified,
    };
    const evidenceText = `${canonicalJson(evidence)}\n`;
    const closureCatalog = {
        schema: HARNESS_CLOSURE_SCHEMA,
        harnesses: Object.fromEntries(
            (["opencode", "pi"] as const).flatMap((name) => {
                const harness = manifest.harnesses[name];
                return harness.closure === undefined
                    ? []
                    : [
                          [
                              name,
                              {
                                  manifest_sha256: closureManifestDigest(
                                      harness.closure,
                                  ),
                                  source_roots: harness.closure.source_roots,
                                  platforms: harness.closure_platforms,
                                  anchors: Object.fromEntries(
                                      harness.closure.source_roots.map((root) => {
                                          const launch = [
                                              ["executable", harness.closure?.executable],
                                              ["interpreter", harness.closure?.interpreter],
                                              ["entrypoint", harness.closure?.entrypoint],
                                          ].find(([, path]) => {
                                              const node = harness.closure?.nodes.find(
                                                  (candidate) => candidate.path === path,
                                              );
                                              return node?.source_root === root;
                                          });
                                          if (launch === undefined) {
                                              fail(
                                                  `harnesses.${name}: source root ${root} has no launch anchor`,
                                              );
                                          }
                                          const node = harness.closure?.nodes.find(
                                              (candidate) =>
                                                  candidate.path === launch[1],
                                          );
                                          if (node === undefined) {
                                              fail(
                                                  `harnesses.${name}: launch anchor node is missing`,
                                              );
                                          }
                                          return [
                                              root,
                                              {
                                                  from: launch[0],
                                                  source_path: node.source_path,
                                              },
                                          ];
                                      }),
                                  ),
                              },
                          ],
                      ];
            }),
        ),
    };
    const closureCatalogText =
        `// biome-ignore-all format: generated canonical release data\n` +
        `// Generated by scripts/qualify-mc-host-production-inputs.ts. Do not edit.\n` +
        `export const qualifiedHarnessClosures = ${canonicalJson(closureCatalog)} as const;\n`;
    const rustClosureEntries = (["opencode", "pi"] as const).flatMap(
        (name) => {
            const harness = manifest.harnesses[name];
            if (harness.closure === undefined) return [];
            const bytes =
                harness.closure_manifest === undefined
                    ? rustRawString(canonicalClosureManifest(harness.closure))
                    : `include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../${harness.closure_manifest.path}"))`;
            return [
                `    (${JSON.stringify(name)}, ${JSON.stringify(closureManifestDigest(harness.closure))}, ${bytes}),`,
            ];
        },
    );
    const closureCatalogRustText =
        "// Generated by scripts/qualify-mc-host-production-inputs.ts. Do not edit.\n" +
        `pub const PRODUCTION_INPUTS_LOCK_SHA256: &str = ${JSON.stringify(lockSha256)};\n` +
        "pub const QUALIFIED_HARNESS_CLOSURES: &[(&str, &str, &str)] = &[\n" +
        `${rustClosureEntries.join("\n")}\n` +
        "];\n";

    const outputs = {
        lock: lockText,
        credentials: credentialsText,
        evidence: evidenceText,
        closureCatalog: closureCatalogText,
        closureCatalogRust: closureCatalogRustText,
    };
    const drift: string[] = [];
    for (const [key, relative] of Object.entries(OUTPUT_PATHS) as [
        keyof typeof OUTPUT_PATHS,
        string,
    ][]) {
        const path = join(rootDir, relative);
        const expected = outputs[key];
        if (options.check) {
            if (key === "evidence") {
                continue;
            }
            if (!existsSync(path)) {
                drift.push(`${relative}: missing`);
            } else if (readFileSync(path, "utf8") !== expected) {
                drift.push(
                    `${relative}: content drift (regenerate with bun scripts/qualify-mc-host-production-inputs.ts)`,
                );
            }
        } else {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, expected);
        }
    }
    return {
        u8Digest,
        lockSha256,
        credentialsSha256,
        productionQualified,
        drift,
        outputs,
    };
}

// ---------------------------------------------------------------------------
// Build-entrypoint consumption gate (U2/U6).
// ---------------------------------------------------------------------------

/**
 * Load and verify the qualification evidence a production build is allowed to
 * consume. Fails closed on absent, malformed, stale (artifact or U8 digest
 * mismatch), test-only, or non-production evidence. Returns the verified
 * evidence and artifact digests for embedding into build inputs.
 */
export function requireQualificationEvidence(rootDir: string): {
    evidence: Record<string, unknown>;
    u8Digest: string;
    lockSha256: string;
    credentialsSha256: string;
} {
    const reject = (message: string): never =>
        fail(`qualification evidence rejected: ${message}`);
    const evidencePath = join(rootDir, OUTPUT_PATHS.evidence);
    if (!existsSync(evidencePath)) {
        reject(`absent (${OUTPUT_PATHS.evidence})`);
    }
    let evidence: Record<string, unknown>;
    try {
        evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    } catch {
        reject("malformed JSON");
    }
    if (
        evidence === null ||
        typeof evidence !== "object" ||
        Array.isArray(evidence) ||
        (evidence as { schema?: unknown }).schema !==
            "magic-context.mc-host-release-qualification/v1"
    ) {
        reject("malformed or unknown schema");
    }
    const contract = buildContract();
    const u8Digest = sha256Hex(canonicalJson(contract));
    if (evidence.release_contract_sha256 !== u8Digest) {
        reject("stale U8 release-contract digest");
    }
    const release = evidence.release as
        | { id?: unknown; version?: unknown }
        | undefined;
    if (
        release?.id !== contract.release.id ||
        release?.version !== contract.release.version
    ) {
        reject("release identity mismatch");
    }
    if (evidence.test_only !== false) {
        reject("test-only evidence can never qualify a production build");
    }
    if (evidence.production_qualified !== true) {
        reject("inputs are not production-qualified");
    }
    const artifacts = evidence.artifacts as
        | Record<string, { path?: unknown; sha256?: unknown }>
        | undefined;
    const digests: Record<string, string> = {};
    for (const [key, relative] of [
        ["production_inputs_lock", OUTPUT_PATHS.lock],
        ["provider_credentials", OUTPUT_PATHS.credentials],
    ] as const) {
        const cited = artifacts?.[key];
        if (cited?.path !== relative || typeof cited.sha256 !== "string") {
            reject(`malformed artifact citation for ${key}`);
        }
        const artifactPath = join(rootDir, relative);
        if (!existsSync(artifactPath)) reject(`missing artifact ${relative}`);
        const actual = sha256Hex(readFileSync(artifactPath, "utf8"));
        if (actual !== cited.sha256) {
            reject(`stale artifact digest for ${relative}`);
        }
        digests[key] = actual;
    }
    return {
        evidence,
        u8Digest,
        lockSha256: digests.production_inputs_lock,
        credentialsSha256: digests.provider_credentials,
    };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function main(): void {
    const args = process.argv.slice(2);
    const check = args.includes("--check") || args.includes("--check-schema");
    const verifyExternalBytes = args.includes("--check");
    const unknown = args.filter((arg) => arg !== "--check" && arg !== "--check-schema");
    if (unknown.length > 0) {
        console.error(`unknown arguments: ${unknown.join(" ")}`);
        process.exit(2);
    }
    const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    let result: QualifyResult;
    try {
        result = generate(rootDir, {
            check,
            ...(check ? { verifyExternalBytes } : {}),
        });
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
    if (check && result.drift.length > 0) {
        console.error("mc-host production-input qualification drift:");
        for (const line of result.drift) console.error(`  - ${line}`);
        process.exit(1);
    }
    console.log(
        `${check ? "checked" : "generated"} mc-host production-input qualification ` +
            `(U8 sha256 ${result.u8Digest}, lock sha256 ${result.lockSha256}, ` +
            `credentials sha256 ${result.credentialsSha256}, production_qualified ${result.productionQualified})`,
    );
}

if (import.meta.main) main();
