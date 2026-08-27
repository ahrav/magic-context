/**
 * U9 production-input and provider-credential qualifier (KTD7, KTD21, KTD23, R51).
 *
 * Generates, deterministically (stable key order, no timestamps, no environment
 * input), three byte-exact outputs:
 *
 *   - release/mc-host-production-inputs.lock.json      (immutable input lock)
 *   - release/mc-host-provider-credentials.json        (closed harness/provider matrix)
 *   - docs/evidence/mc-host-release-qualification.json (qualification evidence)
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
 *   bun scripts/qualify-mc-host-production-inputs.ts                # write outputs
 *   bun scripts/qualify-mc-host-production-inputs.ts --check        # fail on any drift
 *   bun scripts/qualify-mc-host-production-inputs.ts --check --verify-bytes
 *       # additionally re-hash the local artifact bytes (qualifying host only)
 */

import { createHash } from "node:crypto";
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
    realpathSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    buildContract,
    canonicalJson,
    compareDotted,
    exactKeysAsserter,
    generate as generateReleaseOutputs,
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
    evidence: "docs/evidence/mc-host-release-qualification.json",
} as const;

const RELEASE_CONTRACT_PATH = "release/mc-host-release.json";
const TINY_FIXTURE_MANIFEST_PATH =
    "crates/mc-host/tests/fixtures/synapse-tiny/manifest.json";
const QUALIFICATION_FIXTURE_MANIFEST_PATH =
    "scripts/__fixtures__/mc-host-qualification/source-manifest.test-fixture.json";
const BUN_LOCK_PATH = "bun.lock";
/** The workspace whose resolution of the Pi harness package is the released one. */
const PI_HARNESS_WORKSPACE = "packages/pi-plugin";
const MC_HOST_CARGO_TOML_PATH = "crates/mc-host/Cargo.toml";

function fail(message: string): never {
    throw new Error(`mc-host input qualification: ${message}`);
}

/** Shared with the U8 generator so one exact-key contract governs both, while
 *  failures stay attributed to the file the operator actually edited. */
const assertExactKeys = exactKeysAsserter("mc-host input qualification");

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
        // Resolved ORT feature closure (docs/synapse-model-bundle.md §3). Most of
        // it is enabled transitively, so `crossCheckRepoPins` does not assert
        // this exact list against `crates/mc-host/Cargo.toml` — proving the
        // effective graph needs Cargo resolution. What it does enforce there is
        // the security-relevant negative: `default-features = false` on both
        // crates, and no declared feature naming a download, TLS/fetch, Hugging
        // Face, image-model, or accelerator capability.
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
    harness_runtimes: { bun: "1.3.14", node: "24.x", npm: "11.x" },
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
                    "--format",
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
                    "--no-approve",
                    "--no-context-files",
                    "--no-extensions",
                    "--no-prompt-templates",
                    "--no-session",
                    "--no-skills",
                    "--no-tools",
                    "--output",
                    "--print",
                    "--provider",
                    "--require",
                    "--resume",
                    "--session",
                    "--system-prompt",
                    "--thinking",
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
            "entrypoint",
            "extensions",
            "harness",
            "interpreter",
            "modules",
            "native_addons",
            "package",
            "version",
        ],
        node: {
            fields: ["path", "sha256"],
            path_rules: [
                "relative",
                "no_parent_segments",
                "no_symlink_escape",
            ],
        },
        extensions_ordered: true,
        rules: {
            finite_dynamic_imports_only: true,
            no_runtime_import_discovery: true,
            reachable_native_addons_required: true,
            relative_layout_preserved: true,
        },
    },
} as const;

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
                !doc.unsupported_auth_mechanisms.includes(
                    alias.alias_mechanism,
                )
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
            // Count occurrences, not distinct names: a Map keyed by name would
            // collapse a template that repeats one placeholder, and
            // `renderArgumentVariant` substitutes only `field.position`, so
            // every other copy of that token would survive into argv unrendered.
            let placeholderCount = 0;
            variant.template.forEach((token, index) => {
                if (token.startsWith("{") && token.endsWith("}")) {
                    placeholderCount += 1;
                    placeholderPositions.set(token.slice(1, -1), index);
                }
            });
            if (
                placeholderCount !== fieldEntries.length ||
                placeholderPositions.size !== fieldEntries.length
            ) {
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
    // Presence first, then individual caps for every value, then row size —
    // individual-size precedence over aggregate row size (KTD21). The first
    // pass collects the validated pairs so the cap pass cannot silently skip a
    // variable and under-count the row.
    const present: Array<[string, string]> = [];
    for (const name of row.credential_variables) {
        const value = request.credentials[name];
        if (value === undefined || value === "") {
            return { ok: false, reason: "credential_missing" };
        }
        present.push([name, value]);
    }
    for (const [name, value] of present) {
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
    "config",
    "corpus",
    "model_onnx",
    "ort_runtime",
    "special_tokens_map",
    "tokenizer",
    "tokenizer_config",
] as const;

const APPROVED_SPDX = ["Apache-2.0", "MIT"] as const;
const SHA256_RE = /^[0-9a-f]{64}$/;
/**
 * Ref names that identify a moving target rather than one immutable revision.
 * Matched per URL path segment, so a ref is rejected wherever it appears —
 * including as the final segment (`.../repo/main`), which a substring match on
 * `/main/` misses because nothing follows the ref to supply the closing slash.
 */
const MUTABLE_SOURCE_REFS = new Set([
    "main",
    "master",
    "latest",
    "head",
    "nightly",
]);
/**
 * Query-parameter names that carry an access credential. `buildLock` copies
 * `source` verbatim into a committed artifact, so a credential-bearing URL would
 * be published in Git history permanently; and a signed URL is time-limited,
 * which is the opposite of the immutable identity a qualified source asserts.
 *
 * Matched against the name with separators removed, so `X-Amz-Signature`,
 * `access_token`, and `apiKey` all land. Short, ambiguous names are matched
 * exactly instead so an innocuous `design` or `keyspace` is not rejected.
 */
const CREDENTIAL_QUERY_SUBSTRINGS = [
    "token",
    "secret",
    "password",
    "passwd",
    "credential",
    "apikey",
    "accesskey",
    "signature",
    "authorization",
];
const CREDENTIAL_QUERY_EXACT = new Set(["sig", "auth", "key", "pwd", "sas"]);

function isCredentialQueryName(name: string): boolean {
    const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    return (
        CREDENTIAL_QUERY_EXACT.has(normalized) ||
        CREDENTIAL_QUERY_SUBSTRINGS.some((hint) => normalized.includes(hint))
    );
}

/** `startsWith("https://")` does not imply parseability, so report a malformed
 *  URL through `fail` rather than letting a raw `TypeError` escape. */
function parseSourceUrl(key: string, source: string) {
    try {
        return new URL(source);
    } catch {
        fail(`inputs.${key}: source is not a parseable URL`);
    }
}

/**
 * Path *segments* that identify a committed fixture tree or a developer cache.
 * Compared per segment, never as a substring: a real artifact store whose name
 * merely contains one of these words — `/mnt/release/hf-tests/fixtures-store/`,
 * `/opt/prod-node_modules_mirror/` — names nothing that is actually a fixture or
 * a cache, and must not be permanently unqualifiable because of its spelling.
 */
const FIXTURE_OR_CACHE_PATH_SEGMENTS = [
    "synapse-tiny",
    "node_modules",
    ".cache",
    ".bun",
    "target",
];
/** Consecutive segment runs denied wherever they appear (`.../tests/fixtures/...`). */
const FIXTURE_OR_CACHE_SEGMENT_RUNS = [["tests", "fixtures"]];
/**
 * Denied only when qualifying for production. `scripts/__fixtures__` holds the
 * committed qualification fixtures — tiny text stand-ins named after the real
 * artifacts (`model.onnx`, `ort-runtime.so`) carrying `example.invalid`
 * provenance. Those files are the intended input in `test-fixture` mode, so the
 * segment cannot join the all-mode list, but a production manifest that points
 * at them must never reach `productionQualified: true`.
 */
const PRODUCTION_ONLY_DENIED_SEGMENTS = ["__fixtures__"];

/** The denied segment or run a candidate path contains, or `null`. */
function deniedPathSegment(
    candidate: string,
    mode: SourceManifest["mode"],
): string | null {
    const segments = candidate.split(/[\\/]+/);
    const denied = [
        ...FIXTURE_OR_CACHE_PATH_SEGMENTS,
        ...(mode === "production" ? PRODUCTION_ONLY_DENIED_SEGMENTS : []),
    ];
    for (const segment of segments) {
        if (denied.includes(segment)) return segment;
    }
    for (const run of FIXTURE_OR_CACHE_SEGMENT_RUNS) {
        for (let i = 0; i + run.length <= segments.length; i++) {
            if (run.every((part, offset) => segments[i + offset] === part)) {
                return run.join("/");
            }
        }
    }
    return null;
}

/**
 * Resolve a `verify_local_path` to the exact absolute path whose bytes will be
 * hashed, enforcing the U9 path rules that apply to a *production artifact*
 * path: `no_parent_segments` and `no_symlink_escape`. The closure manifest's
 * `relative` rule governs its own `node` paths and deliberately does not apply
 * here — production qualification requires an absolute path instead, because the
 * real artifacts live outside the repository on the qualifying host.
 *
 * The fixture/developer-cache deny-list is applied to the fully symlink-resolved
 * path, not just the spelling in the manifest: a symlink at an allowed path that
 * points into a developer cache must not be able to qualify.
 */
function resolveVerifyPath(
    rootDir: string,
    key: string,
    verifyPath: string,
    mode: SourceManifest["mode"],
): string {
    if (verifyPath.startsWith("~")) {
        fail(`inputs.${key}: home-relative verify path is rejected`);
    }
    // `no_parent_segments` applies to the path as written: normalizing first
    // would silently collapse an interior `..` and accept it.
    if (
        verifyPath
            .split(/[\\/]+/)
            .some((segment) => segment === "..")
    ) {
        fail(`inputs.${key}: parent segments in the verify path are rejected`);
    }
    if (mode === "production" && !isAbsolute(verifyPath)) {
        fail(
            `inputs.${key}: production qualification requires an absolute verify path`,
        );
    }
    const lexical = isAbsolute(verifyPath)
        ? normalize(verifyPath)
        : resolve(rootDir, verifyPath);
    // Resolve symlinks when the bytes exist so the deny-list sees the real
    // location; when absent, keep the lexical path so the caller reports the
    // missing-bytes failure against the path the manifest actually names.
    let resolved = lexical;
    if (existsSync(lexical)) {
        try {
            resolved = realpathSync(lexical);
        } catch {
            fail(`inputs.${key}: verify path could not be resolved`);
        }
    }
    for (const candidate of new Set([verifyPath, lexical, resolved])) {
        const denied = deniedPathSegment(candidate, mode);
        if (denied !== null) {
            fail(
                `inputs.${key}: fixture/developer-cache verify path (${denied}) is rejected`,
            );
        }
    }
    return resolved;
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
    host: { target: string; kernel: string; glibc: string };
    expected_vectors: number;
    tolerance: number;
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
        opencode: {
            package: string;
            version: string | null;
            unqualified_reason?: string;
        };
        pi: {
            package: string;
            version: string | null;
            unqualified_reason?: string;
        };
    };
}

function isPlaceholderSha256(hash: string): boolean {
    return /^(.)\1{63}$/.test(hash);
}

/** Recursively collect every 64-hex value from the committed tiny fixture
 *  manifest so no tiny-fixture artifact byte identity can ever qualify.
 *
 *  In production mode the committed qualification-fixture digests join the set.
 *  The path deny-list alone is spelling-based, so copying those same tiny text
 *  stand-ins to a directory without `__fixtures__` in its name would otherwise
 *  let them qualify; blocking the byte identity follows the relocation. */
function tinyFixtureHashBlacklist(
    rootDir: string,
    mode: SourceManifest["mode"],
): Set<string> {
    const blacklist = new Set<string>();
    const path = join(rootDir, TINY_FIXTURE_MANIFEST_PATH);
    // Required input, not best-effort: a missing manifest would silently empty
    // the blacklist and let committed tiny-fixture bytes qualify as production
    // inputs, so treat absence exactly like the unreadable case below.
    if (!existsSync(path)) {
        fail(`missing tiny-fixture manifest at ${TINY_FIXTURE_MANIFEST_PATH}`);
    }
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
        fail(`unreadable tiny-fixture manifest at ${TINY_FIXTURE_MANIFEST_PATH}`);
    }
    if (mode === "production") {
        const fixturePath = join(rootDir, QUALIFICATION_FIXTURE_MANIFEST_PATH);
        // Absent in a consumer checkout that ships no fixtures; only its digests
        // are being denied, and the path deny-list still covers the in-tree copy.
        if (existsSync(fixturePath)) {
            try {
                collect(JSON.parse(readFileSync(fixturePath, "utf8")));
            } catch {
                fail(
                    `unreadable qualification fixture manifest at ${QUALIFICATION_FIXTURE_MANIFEST_PATH}`,
                );
            }
        }
    }
    return blacklist;
}

function validateQualifiedArtifact(
    rootDir: string,
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
    if (
        typeof artifact.source !== "string" ||
        !artifact.source.startsWith("https://") ||
        artifact.source.endsWith("/")
    ) {
        fail(`inputs.${key}: source must be an https URL naming one artifact`);
    }
    // Compare per path segment so a mutable ref is caught in any position.
    // The host is excluded deliberately: only the path names the revision.
    const sourceUrl = parseSourceUrl(key, artifact.source);
    if (sourceUrl.username !== "" || sourceUrl.password !== "") {
        fail(
            `inputs.${key}: source must not embed URL credentials (userinfo is copied into the committed lock)`,
        );
    }
    for (const [name] of sourceUrl.searchParams) {
        if (isCredentialQueryName(name)) {
            fail(
                `inputs.${key}: source query parameter ${name} carries a credential and is rejected`,
            );
        }
    }
    // A fragment is never sent to the server, so it cannot select artifact bytes:
    // on an immutable artifact URL it is noise at best, and at worst it is where
    // an OAuth-style flow puts an access token — which `buildLock` would copy
    // into the committed lock. Rejecting the whole component closes that class
    // rather than chasing individual credential and ref spellings inside it.
    if (sourceUrl.hash !== "") {
        fail(
            `inputs.${key}: source must not carry a URL fragment (it cannot select bytes and can carry credentials)`,
        );
    }
    const rejectMutableRef = (value: string): void => {
        // Case-folded: a ref differing only in case is still a moving target,
        // and no immutable artifact URL needs a token spelled like one.
        if (MUTABLE_SOURCE_REFS.has(value.toLowerCase())) {
            fail(
                `inputs.${key}: mutable source identity (${value} ref) is rejected`,
            );
        }
    };
    for (const rawSegment of sourceUrl.pathname.split("/")) {
        // `URL.pathname` preserves percent-encoding, so `ma%69n` would survive a
        // literal comparison while the server still resolves it as `main`.
        // Decode before comparing, and treat a malformed escape as a rejection
        // rather than passing the undecodable spelling through.
        let segment: string;
        try {
            segment = decodeURIComponent(rawSegment);
        } catch {
            fail(
                `inputs.${key}: source path segment ${JSON.stringify(rawSegment)} has a malformed percent-escape`,
            );
        }
        // Decoding can reveal separators the split above could not see:
        // `resolve%2Fmain%2Fmodel.onnx` is one raw segment that a server which
        // decodes escaped separators resolves through the moving `main` ref. Split
        // again after decoding so each revealed component is compared on its own.
        for (const token of segment.split(/[\\/]+/)) rejectMutableRef(token);
    }
    // An endpoint can also name its revision in the query string
    // (`/download?ref=main`), and such a URL keeps resolving a moving target
    // however immutable its path looks. Split composite values so a ref buried in
    // `?path=repo/main/model.onnx` is caught.
    //
    // `URLSearchParams` already decoded these values, so they are compared as
    // they are: decoding a second time would turn a literal `%` in a legitimate
    // value into a malformed-escape rejection.
    for (const [, value] of sourceUrl.searchParams) {
        for (const token of value.split(/[\\/,;:@]+/)) rejectMutableRef(token);
    }
    if (
        !Number.isSafeInteger(artifact.size_bytes) ||
        artifact.size_bytes <= 0
    ) {
        fail(`inputs.${key}: size_bytes must be a positive integer`);
    }
    if (typeof artifact.sha256 !== "string" || !SHA256_RE.test(artifact.sha256)) {
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
    const verifyPath = artifact.verify_local_path;
    if (typeof verifyPath !== "string" || verifyPath.length === 0) {
        fail(`inputs.${key}: qualified entries must verify real local bytes`);
    }
    resolveVerifyPath(rootDir, key, verifyPath, mode);
}

export function checkOracleEvidence(
    oracle: OracleEvidence,
    contract: ReleaseContract,
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
    // Nested exactness matters here: an unknown or mis-cased key (`Kernel`)
    // would otherwise read as absent and be reported as a version failure
    // rather than as the typo it is.
    assertExactKeys(
        oracle.host,
        ["target", "kernel", "glibc"],
        "oracle.host",
    );
    if (oracle.host?.target !== "linux-x64-gnu") {
        fail("oracle: the offline oracle must run on the linux-x64-gnu lane");
    }
    // Same comparator the U8 platform gate uses against these same floors, so
    // the qualifier and `evaluatePlatform` cannot disagree on a host version.
    // No format pre-filter on the *spelling*: `compareDotted` exists precisely
    // to read the messy strings real hosts report (`uname -r` gives
    // `4.18.0-513.el8.x86_64`, glibc gives `2.28-236.el8`), taking each segment's
    // leading digit run and counting a segment with no leading digits as 0.
    //
    // Precision is required, though. Because a missing component scores 0, a
    // value shorter than the floor is compared as if its absent components were
    // zeros, so a single high segment decides the result on its own and
    // `999garbage` clears a `4.18` floor without ever naming a minor version.
    // Demand one digit-led component per floor component before comparing: that
    // rejects the truncated garbage while still admitting every distro suffix,
    // which only ever appears after those components.
    //
    // Suffixes also need a direction. `compareDotted` reads only each component's
    // leading digits, so `4.18-rc1` scores exactly equal to a `4.18` floor even
    // though a release candidate precedes 4.18 final. A numeric release suffix
    // (`2.28-236.el8`) means the opposite — 2.28 plus patches — so the two cannot
    // be told apart by shape, only by the marker.
    //
    // A prerelease marker therefore disqualifies only while the version is still
    // exactly at the floor: scan components until one beyond the floor's precision
    // carries a non-zero number, which is the point the version has genuinely gone
    // past it. `4.18.0-rc2` is caught (the `.0` has not moved past `4.18`), while
    // `4.18.0-513.el8` and `4.18.1-rc2` are not, and anything strictly above the
    // floor is never examined — 4.19-rc1 really does follow 4.18.
    const PRERELEASE_MARKER = /^\d*[-.]?(?:rc|pre|alpha|beta|dev|snapshot)/i;
    const versionAtLeast = (value: unknown, floor: string): boolean => {
        if (typeof value !== "string" || value.length === 0) {
            return false;
        }
        const parts = value.split(".");
        const floorParts = floor.split(".");
        if (parts.length < floorParts.length) return false;
        for (let i = 0; i < floorParts.length; i++) {
            if (!/^\d/.test(parts[i] ?? "")) return false;
        }
        const ordering = compareDotted(value, floor);
        if (Number.isNaN(ordering) || ordering < 0) return false;
        if (ordering === 0) {
            for (const [index, part] of parts.entries()) {
                if (index >= floorParts.length) {
                    const leading = /^\d*/.exec(part)?.[0] ?? "";
                    if (Number(leading || "0") > 0) break;
                }
                if (PRERELEASE_MARKER.test(part)) return false;
            }
        }
        return true;
    };
    if (
        !versionAtLeast(oracle.host.kernel, linux.kernel_min) ||
        !versionAtLeast(oracle.host.glibc, linux.glibc_min)
    ) {
        fail("oracle: host must meet the exact minimum Linux floor");
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
    if (oracle.network_access !== "none") {
        fail("oracle: recorded network access must be none");
    }
}

export function validateSourceManifest(
    manifest: unknown,
    contract: ReleaseContract,
    rootDir: string,
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
    const blacklist = tinyFixtureHashBlacklist(rootDir, m.mode);
    assertExactKeys(m.inputs, [...INPUT_KEYS], "inputs");
    for (const key of INPUT_KEYS) {
        const artifact = m.inputs[key];
        if (artifact === null || typeof artifact !== "object") {
            fail(`inputs.${key} must be an object`);
        }
        if (artifact.qualified === true) {
            validateQualifiedArtifact(rootDir, key, artifact, m.mode, blacklist);
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
    if (m.oracle !== null) checkOracleEvidence(m.oracle, contract);
    assertExactKeys(m.harnesses, ["opencode", "pi"], "harnesses");
    const expectPackage = {
        opencode: CREDENTIALS_DOC.harnesses.opencode.package,
        pi: CREDENTIALS_DOC.harnesses.pi.package,
    } as const;
    for (const name of ["opencode", "pi"] as const) {
        const harness = m.harnesses[name];
        assertExactKeys(
            harness,
            ["package", "version"],
            `harnesses.${name}`,
            ["unqualified_reason"],
        );
        if (harness.package !== expectPackage[name]) {
            fail(
                `harnesses.${name}: package must be ${expectPackage[name]}`,
            );
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
        } else if (
            typeof harness.version !== "string" ||
            !/^\d+\.\d+\.\d+$/.test(harness.version)
        ) {
            fail(`harnesses.${name}: version must be exact semver or null`);
        }
    }
}

function verifyArtifactBytes(
    rootDir: string,
    key: string,
    artifact: QualifiedArtifact,
    mode: SourceManifest["mode"],
): void {
    const path = resolveVerifyPath(
        rootDir,
        key,
        artifact.verify_local_path,
        mode,
    );
    if (!existsSync(path)) {
        fail(`inputs.${key}: verify bytes missing at ${artifact.verify_local_path}`);
    }
    // Production artifacts are hundreds of MB (ONNX model, ORT shared library):
    // compare the cheap size first, then hash in fixed-size chunks so peak
    // memory stays constant instead of scaling with the artifact.
    const size = statSync(path).size;
    if (size !== artifact.size_bytes) {
        fail(
            `inputs.${key}: byte size ${size} does not match locked size ${artifact.size_bytes}`,
        );
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const fd = openSync(path, "r");
    try {
        let read = readSync(fd, buffer, 0, buffer.length, null);
        while (read > 0) {
            hash.update(buffer.subarray(0, read));
            read = readSync(fd, buffer, 0, buffer.length, null);
        }
    } finally {
        closeSync(fd);
    }
    const digest = hash.digest("hex");
    if (digest !== artifact.sha256) {
        fail(
            `inputs.${key}: byte digest does not match the locked sha256 (input bytes changed)`,
        );
    }
}

/**
 * Capabilities the pinned ORT/fastembed closure must not carry. Matched as
 * substrings of each declared feature name so a renamed or versioned spelling
 * (`download-binaries`, `fetch-models`, `cuda-12`) still lands, since the point
 * is to deny a class of behavior rather than an exact feature list.
 */
const FORBIDDEN_RUNTIME_FEATURE_SUBSTRINGS = [
    "download",
    "fetch",
    "hf-hub",
    "hf_hub",
    "online",
    "tls",
    "cuda",
    "tensorrt",
    "directml",
    "coreml",
    "rocm",
    "openvino",
    "onednn",
    "xnnpack",
    "nnapi",
    "armnn",
    "qnn",
    "migraphx",
    "cann",
    "rknpu",
    "tvm",
    "vitis",
    "webgpu",
    "image",
];

/**
 * Strip TOML comments from one line, leaving `#` inside a quoted value alone.
 *
 * Comments are the one place a `Cargo.toml` can contain text that reads exactly
 * like a declaration but means nothing: a commented `version = "=2.0.0-rc.13"`
 * inside a multiline features array would otherwise satisfy a textual check while
 * Cargo resolves whatever the real key says. Removing them before any comparison
 * closes that for every check at once, rather than per pattern.
 *
 * Basic strings only. TOML literal strings (`'...'`) and multi-line strings do
 * not appear in Cargo dependency declarations, and treating one as unquoted would
 * only truncate the entry into a rejection.
 */
function stripTomlComments(line: string): string {
    let inString = false;
    let escaped = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === "#") return line.slice(0, i);
    }
    return line;
}

/**
 * Extract one crate's complete inline dependency entry from the `[dependencies]`
 * table of `Cargo.toml`, across however many lines its inline table spans, with
 * comments removed.
 *
 * Returns `null` unless the crate is declared exactly once in the whole file and
 * that declaration is in `[dependencies]`. Section tracking is the load-bearing
 * part: a bare textual search for `ort = ` would validate a decoy assignment
 * under an unrelated table such as `[package.metadata.qualification]` and never
 * reach the real dependency. Requiring uniqueness covers the other direction, so
 * a second declaration under `[target.'cfg(...)'.dependencies]` cannot contribute
 * features this check never sees. `null` also covers the absent, unbalanced, and
 * `[dependencies.<crate>]` section forms; callers must fail closed on it rather
 * than read it as "declares nothing".
 *
 * This is a scan, not a TOML parser. Every shape it cannot account for fails, so
 * being wrong costs a false rejection with an actionable message rather than a
 * false qualification. Brace and bracket counting suffices because Cargo
 * dependency values are versions, paths, and URLs, none of which contain them.
 */
function inlineDependencyEntry(cargo: string, crate: string): string | null {
    const lines = cargo.split("\n").map(stripTomlComments);
    const starts: number[] = [];
    let section = "";
    for (const [index, line] of lines.entries()) {
        const trimmed = line.trim();
        const header = /^\[([^\]]+)\]$/.exec(trimmed);
        if (header !== null) {
            section = header[1] ?? "";
            continue;
        }
        if (!trimmed.startsWith(`${crate} = `)) continue;
        // Any declaration outside `[dependencies]` still counts, so a decoy or a
        // target-specific duplicate is reported as ambiguity rather than ignored.
        starts.push(section === "dependencies" ? index : -1);
    }
    if (starts.length !== 1 || starts[0] === -1) return null;
    const start = starts[0] as number;
    const collected: string[] = [];
    let depth = 0;
    for (let i = start; i < lines.length; i++) {
        const line = lines[i] ?? "";
        collected.push(line.trim());
        for (const char of line) {
            if (char === "{" || char === "[") depth++;
            else if (char === "}" || char === "]") depth--;
        }
        if (depth <= 0) return collected.join(" ");
    }
    return null;
}

/**
 * Assert one `Cargo.toml` dependency entry pins `version` exactly, opts out of
 * default features, and declares no forbidden capability.
 *
 * The declared array is not the effective feature closure — most of
 * `RUNTIME_IDENTITY.rust_crates.ort_features` arrives transitively — so this
 * enforces the closure's negative half, which is the part a silent edit would
 * exploit: adding a download, TLS, or accelerator feature while leaving the
 * version pin untouched.
 *
 * Every unreadable shape fails rather than passing vacuously. A declared
 * `features` key whose array cannot be read is the dangerous case: reading it as
 * an empty list is exactly how a reformatted multiline array would smuggle a
 * forbidden capability past the version pin.
 */
function assertPinnedCrateFeatures(
    cargo: string,
    crate: string,
    version: string,
): void {
    const entry = inlineDependencyEntry(cargo, crate);
    if (entry === null) {
        fail(
            `${crate} must be declared exactly once, as an inline dependency table under [dependencies], in ${MC_HOST_CARGO_TOML_PATH}; the qualified feature closure cannot be checked otherwise`,
        );
    }
    if (!entry.includes(`version = "=${version}"`)) {
        fail(
            `pinned ${crate} identity does not match ${MC_HOST_CARGO_TOML_PATH}`,
        );
    }
    if (!/default-features\s*=\s*false/.test(entry)) {
        fail(
            `${crate} in ${MC_HOST_CARGO_TOML_PATH} must set default-features = false`,
        );
    }
    const declared = /features\s*=\s*\[([^\]]*)\]/.exec(entry);
    // `default-features` ends in the same word, so require a boundary before it.
    if (/(?:^|[\s,{])features\s*=/.test(entry) && declared === null) {
        fail(
            `${crate} in ${MC_HOST_CARGO_TOML_PATH} declares a features list this qualifier cannot read`,
        );
    }
    for (const raw of declared?.[1]?.split(",") ?? []) {
        const feature = raw.trim().replace(/^["']|["']$/g, "").toLowerCase();
        if (feature.length === 0) continue;
        const forbidden = FORBIDDEN_RUNTIME_FEATURE_SUBSTRINGS.find((hint) =>
            feature.includes(hint),
        );
        if (forbidden !== undefined) {
            fail(
                `${crate} feature ${feature} in ${MC_HOST_CARGO_TOML_PATH} is outside the qualified closure (${forbidden})`,
            );
        }
    }
}

/**
 * Strip trailing commas from `bun.lock`'s JSONC so it can be parsed as JSON.
 *
 * String-aware, because a lockfile carries package names, version ranges, and
 * integrity hashes: a blind regex would corrupt any value that legitimately ends
 * in a comma before a closing brace.
 */
function stripJsoncTrailingCommas(text: string): string {
    let out = "";
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i] as string;
        if (inString) {
            out += char;
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            out += char;
            continue;
        }
        if (char === ",") {
            // Look past whitespace for a closer; drop the comma only then.
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j] as string)) j++;
            const next = text[j];
            if (next === "}" || next === "]") continue;
        }
        out += char;
    }
    return out;
}

/**
 * Resolve the version `workspace` actually gets for `pkg`, from `bun.lock`'s
 * `packages` table.
 *
 * A nested resolution is keyed by the *consumer's package name*, not its
 * directory (`@cortexkit/pi-magic-context/<pkg>`, never `packages/pi-plugin/<pkg>`
 * — no key in the table is a filesystem path), so the workspace's name is read
 * from `workspaces[workspace].name` and the nested entry is preferred over the
 * hoisted one when both exist.
 *
 * This replaces a substring search for `"<pkg>@<version>"`, which proved only that
 * the version appeared somewhere in the file — a transitive copy at an unrelated
 * version would satisfy it while the workspace resolved to something else.
 *
 * Returns `null` when the lockfile cannot be read, the workspace is not declared,
 * or the package is not resolved, so callers fail closed instead of accepting an
 * unverified version.
 */
function resolveLockedVersion(
    lockText: string,
    workspace: string,
    pkg: string,
): string | null {
    let lock: {
        packages?: Record<string, unknown>;
        workspaces?: Record<string, { name?: unknown }>;
    };
    try {
        lock = JSON.parse(stripJsoncTrailingCommas(lockText));
    } catch {
        return null;
    }
    const packages = lock.packages;
    if (packages === null || typeof packages !== "object") return null;
    const consumer = lock.workspaces?.[workspace]?.name;
    if (typeof consumer !== "string" || consumer.length === 0) return null;
    const entry = packages[`${consumer}/${pkg}`] ?? packages[pkg];
    // Each value is `[ "<name>@<version>", ... ]`.
    const descriptor = Array.isArray(entry) ? entry[0] : undefined;
    if (typeof descriptor !== "string") return null;
    // Scoped names begin with `@`, so split at the last separator.
    const at = descriptor.lastIndexOf("@");
    if (at <= 0) return null;
    if (descriptor.slice(0, at) !== pkg) return null;
    return descriptor.slice(at + 1);
}

/** Repo-pinned identity cross-checks (bun.lock harness versions, Cargo crate pins). */
function crossCheckRepoPins(rootDir: string, manifest: SourceManifest): void {
    const bunLockPath = join(rootDir, BUN_LOCK_PATH);
    const piVersion = manifest.harnesses.pi.version;
    if (piVersion !== null) {
        if (!existsSync(bunLockPath)) {
            fail("bun.lock is required to qualify the exact Pi version");
        }
        const pkg = manifest.harnesses.pi.package;
        const locked = resolveLockedVersion(
            readFileSync(bunLockPath, "utf8"),
            PI_HARNESS_WORKSPACE,
            pkg,
        );
        if (locked === null) {
            fail(
                `harnesses.pi: bun.lock does not resolve ${pkg} for ${PI_HARNESS_WORKSPACE}`,
            );
        }
        if (locked !== piVersion) {
            fail(
                `harnesses.pi: version ${piVersion} does not match the resolved bun.lock pin (${locked})`,
            );
        }
    }
    const cargoPath = join(rootDir, MC_HOST_CARGO_TOML_PATH);
    if (manifest.mode === "production") {
        if (!existsSync(cargoPath)) {
            fail("crates/mc-host/Cargo.toml is required to qualify the ORT crate pins");
        }
        const cargo = readFileSync(cargoPath, "utf8");
        assertPinnedCrateFeatures(
            cargo,
            "fastembed",
            RUNTIME_IDENTITY.rust_crates.fastembed,
        );
        assertPinnedCrateFeatures(
            cargo,
            "ort",
            RUNTIME_IDENTITY.rust_crates.ort,
        );
    }
}

// ---------------------------------------------------------------------------
// Lock, credentials, and evidence construction.
// ---------------------------------------------------------------------------

function buildLock(
    manifest: SourceManifest,
    contract: ReleaseContract,
    u8Digest: string,
): {
    lock: Record<string, unknown>;
    unqualified: string[];
    productionQualified: boolean;
} {
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
            harnesses[name] = {
                package: harness.package,
                version: harness.version,
            };
        }
    }
    unqualified.sort();
    // Single source of truth for the release verdict: the lock records it and
    // the evidence artifact reuses this exact value, so the artifact a build
    // gate reads can never disagree with the lock it cites.
    const productionQualified =
        manifest.mode === "production" && unqualified.length === 0;
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
        production_qualified: productionQualified,
        unqualified,
    };
    return { lock, unqualified, productionQualified };
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
    options: { check: boolean; verifyBytes?: boolean },
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
    validateSourceManifest(manifestRaw, contract, rootDir);
    const manifest = manifestRaw;
    // Byte verification needs the real artifacts on disk at the manifest's
    // (absolute, in production) verify paths, which only the qualifying host
    // has. Drift checking must stay portable so CI can guard the committed
    // lock, so verify bytes in write mode and only on explicit request in
    // --check mode.
    const verifyBytes = options.verifyBytes ?? !options.check;
    if (verifyBytes) {
        for (const key of INPUT_KEYS) {
            const artifact = manifest.inputs[key];
            if (artifact.qualified) {
                verifyArtifactBytes(rootDir, key, artifact, manifest.mode);
            }
        }
    }
    crossCheckRepoPins(rootDir, manifest);

    const {
        lock,
        unqualified,
        productionQualified,
    } = buildLock(manifest, contract, u8Digest);
    const lockText = `${canonicalJson(lock)}\n`;
    const lockSha256 = sha256Hex(lockText);

    const credentials = {
        ...CREDENTIALS_DOC,
        release: { id: contract.release.id, version: contract.release.version },
        release_contract_sha256: u8Digest,
    };
    const credentialsText = `${canonicalJson(credentials)}\n`;
    const credentialsSha256 = sha256Hex(credentialsText);

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

    const outputs = {
        lock: lockText,
        credentials: credentialsText,
        evidence: evidenceText,
    };
    const drift: string[] = [];
    for (const [key, relative] of Object.entries(OUTPUT_PATHS) as [
        keyof typeof OUTPUT_PATHS,
        string,
    ][]) {
        const path = join(rootDir, relative);
        const expected = outputs[key];
        if (options.check) {
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
 * mismatch), test-only, or non-production evidence. The production verdict is
 * re-derived from the digest-verified lock bytes rather than trusted from the
 * evidence file's own `production_qualified` field, and every committed U8 and U9
 * output must equal a canonical regeneration from the committed sources, so a
 * hand-edited lock, credential matrix, or generated contract cannot pass however
 * consistently its digests are updated.
 *
 * Trust boundary: this gate proves the committed *description* of the release is
 * canonical and production-qualified. It does not hash the production artifacts
 * that description names unless `verifyBytes` is requested — the lock records
 * each artifact's `sha256` but deliberately not its `verify_local_path`, which is
 * host-specific, and the real bytes exist only on the qualifying host. A build
 * running on that host should pass `verifyBytes: true` to re-hash them here; a
 * build elsewhere must verify the bytes it actually embeds against the returned
 * lock digest itself.
 *
 * Returns the verified evidence and artifact digests for embedding into build
 * inputs.
 */
export function requireQualificationEvidence(
    rootDir: string,
    options: { verifyBytes?: boolean } = {},
): {
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
    // The evidence's own `production_qualified`/`test_only` bits are
    // self-describing and therefore not authority: re-derive the verdict from
    // the lock bytes just digest-verified above. Evidence that claims
    // qualification over a lock that records unqualified inputs fails closed.
    const lock = ((): Record<string, unknown> => {
        try {
            return JSON.parse(
                readFileSync(join(rootDir, OUTPUT_PATHS.lock), "utf8"),
            );
        } catch {
            return reject(`malformed JSON in ${OUTPUT_PATHS.lock}`);
        }
    })();
    if (lock.release_contract_sha256 !== u8Digest) {
        reject(`stale U8 release-contract digest in ${OUTPUT_PATHS.lock}`);
    }
    if (lock.mode !== "production") {
        reject(
            `inputs are not production-qualified (lock mode ${String(lock.mode)})`,
        );
    }
    if (!Array.isArray(lock.unqualified) || lock.unqualified.length > 0) {
        const count = Array.isArray(lock.unqualified)
            ? lock.unqualified.length
            : "malformed";
        reject(
            `inputs are not production-qualified (lock records ${count} unqualified inputs)`,
        );
    }
    if (lock.production_qualified !== true) {
        reject("inputs are not production-qualified (lock verdict is not true)");
    }
    // `unqualified` and `production_qualified` are summary fields, so an edit
    // that clears both still leaves the per-row truth behind. Re-derive the
    // verdict from every row the lock actually carries: any input, the oracle,
    // or any harness still marked unqualified contradicts the summary.
    const rows = lock.inputs as
        | Record<string, { qualified?: unknown }>
        | undefined;
    if (rows === null || typeof rows !== "object" || Array.isArray(rows)) {
        reject(`malformed inputs table in ${OUTPUT_PATHS.lock}`);
    }
    for (const key of INPUT_KEYS) {
        if (rows?.[key]?.qualified !== true) {
            reject(`lock row inputs.${key} is not qualified`);
        }
    }
    if ((lock.oracle as { qualified?: unknown })?.qualified !== true) {
        reject("lock row oracle is not qualified");
    }
    const harnesses = lock.harnesses as
        | Record<string, { version?: unknown }>
        | undefined;
    for (const name of ["opencode", "pi"] as const) {
        // A qualified harness records its version as a bare string; an
        // unqualified one records a `{ qualified: false, reason }` object.
        if (typeof harnesses?.[name]?.version !== "string") {
            reject(`lock row harnesses.${name} is not qualified`);
        }
    }
    // Everything above reads markers: it proves the lock *says* every row
    // qualified, not that the rows still carry real artifact hashes, sizes,
    // licenses, oracle results, or harness identities — `{ "qualified": true }`
    // satisfies each one. Nothing above reads the generated U8 consumer
    // artifacts either, and it is the generated Rust contract the runtime
    // actually compiles, not the digest of the in-source literal.
    //
    // Both gaps close the same way: regenerate every U8 and U9 output from the
    // committed sources and require the committed bytes to match. Stripped lock
    // rows, a replaced credential matrix, and an edited generated contract all
    // fail that comparison, whatever digest the evidence cites.
    const u8 = generateReleaseOutputs(rootDir, { check: true });
    if (u8.drift.length > 0) {
        reject(`generated U8 outputs are not canonical: ${u8.drift.join("; ")}`);
    }
    const regenerated = generate(rootDir, {
        check: true,
        verifyBytes: options.verifyBytes,
    });
    if (regenerated.drift.length > 0) {
        reject(
            `committed qualification outputs are not a canonical regeneration: ${regenerated.drift.join("; ")}`,
        );
    }
    if (!regenerated.productionQualified) {
        reject("the canonical regeneration is not production-qualified");
    }
    if (
        regenerated.lockSha256 !== digests.production_inputs_lock ||
        regenerated.credentialsSha256 !== digests.provider_credentials
    ) {
        reject("regenerated artifact digests do not match the cited digests");
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
    const check = args.includes("--check");
    const verifyBytes = args.includes("--verify-bytes");
    const unknown = args.filter(
        (arg) => arg !== "--check" && arg !== "--verify-bytes",
    );
    if (unknown.length > 0) {
        console.error(`unknown arguments: ${unknown.join(" ")}`);
        process.exit(2);
    }
    const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    let result: QualifyResult;
    try {
        result = generate(rootDir, {
            check,
            verifyBytes: verifyBytes ? true : undefined,
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
