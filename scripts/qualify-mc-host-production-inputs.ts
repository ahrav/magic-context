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
    evaluatePlatform,
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
/** Cargo resolves `[patch]`/`[replace]` overrides from here, not from the leaf. */
const WORKSPACE_CARGO_TOML_PATH = "Cargo.toml";

function fail(message: string): never {
    throw new Error(`mc-host input qualification: ${message}`);
}

/** Shared with the U8 generator so one exact-key contract governs both, while
 *  failures stay attributed to the file the operator actually edited. */
const assertExactKeys = exactKeysAsserter("mc-host input qualification");

/**
 * A required free-text attestation: present, a string, and carrying something a
 * human wrote. Blank-checking only the length accepts `"   "`, which reads as an
 * approver or a provenance record in the committed lock while asserting nothing.
 */
function isFilledText(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
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

/** Inputs whose bytes are JSON. The model and the ORT shared library are not, and
 *  their internal validity is the runtime bundle validator's to judge. */
const JSON_SHAPED_INPUTS: ReadonlySet<string> = new Set([
    "config",
    "corpus",
    "special_tokens_map",
    "tokenizer",
    "tokenizer_config",
]);

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
/**
 * Host names reserved by RFC 2606 and RFC 6761, plus loopback. None of them can
 * resolve to a server holding a production artifact, so a production lock naming
 * one records provenance nobody can act on — including the `example.invalid` hosts
 * the committed test fixtures use, which is exactly the value that must not reach a
 * production manifest by being left in place.
 *
 * Matched on the host and its parent suffixes, so `models.example.invalid` lands.
 */
const RESERVED_SOURCE_HOST_SUFFIXES = [
    "invalid",
    "test",
    "example",
    "localhost",
    "local",
    "example.com",
    "example.net",
    "example.org",
    "127.0.0.1",
    "::1",
];

/** The IPv4 loopback block, which is reserved in full rather than at `.1` alone. */
const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * The reserved-host comparison form of a URL hostname: lowercased, IPv6 brackets
 * stripped, and an IPv4-mapped IPv6 literal reduced to the IPv4 address it carries.
 *
 * `URL.hostname` brackets an IPv6 literal, so a bare `::1` entry would never match
 * without stripping. It also canonicalizes `[::ffff:127.0.0.1]` to
 * `[::ffff:7f00:1]` — loopback written in a form that equals neither `127.0.0.1`
 * nor `::1` — so the mapped prefix is reduced to dotted quad before comparison.
 * Decimal and octal spellings need no help here: the parser already normalizes
 * `2130706433` and `0177.0.0.1` to `127.0.0.1`.
 */
function reservedHostForm(hostname: string): string {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (hex !== null) {
        const high = Number.parseInt(hex[1] ?? "", 16);
        const low = Number.parseInt(hex[2] ?? "", 16);
        return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
    }
    // The dotted-quad spelling of the same mapping, which `URL` preserves as written.
    const dotted = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/.exec(host);
    return dotted?.[1] ?? host;
}

/** The decoded path segments of a source URL, refusing a malformed escape. */
function sourcePathSegments(url: URL): string[] {
    return url.pathname.split("/").map((raw) => {
        try {
            return decodeURIComponent(raw);
        } catch {
            return raw;
        }
    });
}

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
    //
    // `realpathSync.native` deliberately, matching `safeRealpath` in the plugin's
    // enforcement-artifact canonicalizer: the OS `realpath(3)` is the authority on
    // symlink resolution, and two security checks in one repository should not
    // disagree about what a path resolves to. Not imported from there — release
    // tooling depending on a plugin feature's internals would point the coupling
    // the wrong way — so the shared decision is the primitive, not the call.
    let resolved = lexical;
    if (existsSync(lexical)) {
        try {
            resolved = realpathSync.native(lexical);
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
    host: {
        target: string;
        kernel: string;
        glibc: string;
        /** The certified Linux lane executes the sealed ORT object through
         *  `/proc/self/fd`; an oracle on a host that cannot must not qualify it. */
        procfs_self_fd_exec: boolean;
    };
    expected_vectors: number;
    tolerance: number;
    network_access: string;
    /** The recorded outcome. Only `"pass"` qualifies. */
    result: string;
    /** Vectors actually compared; must equal `expected_vectors`. */
    vectors_compared: number;
    /** Worst per-vector deviation observed; must be within `tolerance`. */
    observed_max_error: number;
    /**
     * The artifact digests the oracle ran against, one per qualified input.
     *
     * This is the oracle declaring its own inputs, cross-checked against the
     * qualified set — not a recomputation of the Synapse fingerprint, which is a
     * composite over model, tokenizer, config, corpus, table epoch, and embedding
     * parameters and would have to be derived the way the Rust side derives it.
     * What it does establish is that a transcript cannot outlive the bytes it
     * describes: requalifying an artifact changes its digest, and a retained
     * oracle then names bytes that are no longer in the lock.
     */
    bound_inputs: Record<string, string>;
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
        !artifact.source.startsWith("https://")
    ) {
        fail(`inputs.${key}: source must be an https URL naming one artifact`);
    }
    // Compare per path segment so a mutable ref is caught in any position.
    // The host is excluded deliberately: only the path names the revision.
    const sourceUrl = parseSourceUrl(key, artifact.source);
    // Judged on the parsed path rather than the spelling. A dot segment moves the
    // trailing slash out of the string — `…/<digest>/model.onnx/..` parses to
    // `/…/<digest>/` — and the digest survives as a segment, so the
    // content-address check below still passed a URL naming a directory.
    if (sourceUrl.pathname.endsWith("/")) {
        fail(`inputs.${key}: source must be an https URL naming one artifact`);
    }
    if (sourceUrl.username !== "" || sourceUrl.password !== "") {
        fail(
            `inputs.${key}: source must not embed URL credentials (userinfo is copied into the committed lock)`,
        );
    }
    // A reserved name can never identify a retrievable artifact, so a production
    // lock naming one records provenance that cannot be acted on. Allowed in
    // `test-fixture` mode, which is what the committed fixtures use.
    if (mode === "production") {
        const host = reservedHostForm(sourceUrl.hostname);
        const reserved =
            RESERVED_SOURCE_HOST_SUFFIXES.find(
                (suffix) => host === suffix || host.endsWith(`.${suffix}`),
            ) ??
            // The whole 127.0.0.0/8 block is loopback, not only `127.0.0.1`.
            (LOOPBACK_IPV4.test(host) ? "127.0.0.0/8" : undefined);
        if (reserved !== undefined) {
            fail(
                `inputs.${key}: source host ${host} is reserved (${reserved}) and can never serve a production artifact`,
            );
        }
    }
    for (const [name] of sourceUrl.searchParams) {
        if (isCredentialQueryName(name)) {
            fail(
                `inputs.${key}: source query parameter ${name} carries a credential and is rejected`,
            );
        }
    }
    // Names are not enough: a credential hides just as well inside a *value*, as a
    // nested URL with its own userinfo, and one level down from that too. Rather
    // than chase nesting depth, production rejects the whole component — a source
    // whose path must already name its content digest has nothing left for a query
    // string to identify, so there is no legitimate production form to lose.
    // `test-fixture` mode keeps the name and value checks, which is where the
    // mutable-ref-in-query rules still apply.
    if (mode === "production" && sourceUrl.search !== "") {
        fail(
            `inputs.${key}: production source must not carry a query string (it cannot be proven credential-free and the path already names the content)`,
        );
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
    // Immutability by denylist can never be complete: an unlisted branch name like
    // `develop` reads as immutable simply because nobody thought of it. Production
    // therefore requires the path to name the content positively — a segment that is
    // the artifact's own digest, or any content-addressed revision of git-SHA-1
    // length or longer. The ref denylist stays as defense in depth for both modes,
    // since a mutable ref alongside a digest is still a manifest worth rejecting.
    if (mode === "production") {
        const addressed = sourcePathSegments(sourceUrl).some(
            (segment) =>
                segment.toLowerCase() === artifact.sha256 ||
                /^[0-9a-f]{40,}$/i.test(segment),
        );
        if (!addressed) {
            fail(
                `inputs.${key}: production source must name its content — no path segment is the artifact digest or a content-addressed revision`,
            );
        }
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
    if (!isFilledText(artifact.provenance)) {
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
    if (!isFilledText(license.approved_by)) {
        fail(`inputs.${key}: license approval must name an approver`);
    }
    const verifyPath = artifact.verify_local_path;
    if (!isFilledText(verifyPath)) {
        fail(`inputs.${key}: qualified entries must verify real local bytes`);
    }
    resolveVerifyPath(rootDir, key, verifyPath, mode);
}

export function checkOracleEvidence(
    oracle: OracleEvidence,
    contract: ReleaseContract,
    inputs: Record<(typeof INPUT_KEYS)[number], ArtifactSource>,
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
            "result",
            "vectors_compared",
            "observed_max_error",
            "bound_inputs",
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
    // Nested exactness matters here: an unknown or mis-cased key (`Kernel`)
    // would otherwise read as absent and be reported as a capability failure
    // rather than as the typo it is.
    assertExactKeys(
        oracle.host,
        ["target", "kernel", "glibc", "procfs_self_fd_exec"],
        "oracle.host",
    );
    if (oracle.host?.target !== "linux-x64-gnu") {
        fail("oracle: the offline oracle must run on the linux-x64-gnu lane");
    }
    // Run the recorded host through the U8 platform gate itself rather than
    // re-deriving its floors here. Sharing a predicate made the two agree; running
    // the same function makes them identical by construction, which is what the
    // last divergence between them argued for. It also brings the capability
    // requirements along: the certified Linux lane demands `procfs_self_fd_exec`,
    // so an oracle that loaded the sealed ORT object by some other path cannot
    // qualify evidence for a host that never exercised the production path.
    const platform = evaluatePlatform(contract, {
        os: "linux",
        arch: "x64",
        libc: "gnu",
        kernel: oracle.host.kernel,
        glibc: oracle.host.glibc,
        procfsSelfFdExec: oracle.host.procfs_self_fd_exec,
    });
    if (!platform.supported || platform.target !== "linux-x64-gnu") {
        fail(
            "oracle: recorded host does not satisfy the certified linux-x64-gnu lane",
        );
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
    // Everything above describes how the oracle was *run*. None of it says the
    // comparison passed, and a run that failed or never happened produces exactly
    // the same parameters — so without a recorded outcome, presence was being read
    // as success. Canonical regeneration cannot close that, because the outcome is
    // absent from the source it regenerates from.
    if (oracle.result !== "pass") {
        fail(
            `oracle: recorded result must be "pass" (got ${JSON.stringify(oracle.result)})`,
        );
    }
    if (oracle.vectors_compared !== oracle.expected_vectors) {
        fail(
            `oracle: compared ${JSON.stringify(oracle.vectors_compared)} vectors, expected ${oracle.expected_vectors}`,
        );
    }
    // A pass means every vector came in within tolerance, so the worst deviation
    // observed is the claim that has to hold. `<=` matches the tolerance's own
    // inclusive reading, and a negative or non-finite value is not a deviation.
    if (
        typeof oracle.observed_max_error !== "number" ||
        !Number.isFinite(oracle.observed_max_error) ||
        oracle.observed_max_error < 0 ||
        oracle.observed_max_error > oracle.tolerance
    ) {
        fail(
            `oracle: observed_max_error must be a finite value in [0, ${oracle.tolerance}]`,
        );
    }
    // A recorded pass says the comparison succeeded; it does not say over which
    // bytes. Without that binding, evidence from another embedding space — or an
    // oracle retained across a requalification that changed the artifacts — still
    // reads as a pass for the current bundle.
    assertExactKeys(oracle.bound_inputs, [...INPUT_KEYS], "oracle.bound_inputs");
    for (const key of INPUT_KEYS) {
        const bound = oracle.bound_inputs[key];
        if (typeof bound !== "string" || !SHA256_RE.test(bound)) {
            fail(
                `oracle.bound_inputs.${key} must be 64 lowercase hex naming the bytes the oracle ran against`,
            );
        }
        const artifact = inputs[key];
        if (!artifact.qualified) {
            // An unqualified input already lands in `unqualified[]` and forces
            // `production_qualified: false`, so no release can consume this state.
            // Failing here instead would make it unrepresentable, and release
            // engineering has to be able to record inputs and the oracle
            // incrementally — the tool's contract is that gaps propagate to the
            // verdict rather than aborting the run.
            continue;
        }
        if (artifact.sha256 !== bound) {
            fail(
                `oracle: bound_inputs.${key} names bytes that are not the qualified ones (oracle ${bound}, lock ${artifact.sha256})`,
            );
        }
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
            if (!isFilledText(artifact.reason)) {
                fail(`inputs.${key}: unqualified entries must state a reason`);
            }
            assertExactKeys(artifact, ["qualified", "reason"], `inputs.${key}`);
        } else {
            fail(`inputs.${key}: qualified must be true or false`);
        }
    }
    if (m.oracle !== null) checkOracleEvidence(m.oracle, contract, m.inputs);
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
            if (!isFilledText(harness.unqualified_reason)) {
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
    // Byte identity is not loadability. Matching the locked digest proves these are
    // the intended bytes; it says nothing about whether the runtime can parse them,
    // so a plain-text stand-in with a correct digest qualifies and then fails at
    // bundle load. Checking the JSON inputs parse is the cheap part of that gap and
    // catches exactly that case.
    //
    // Shape only, deliberately. The schema each file must satisfy lives in the Rust
    // bundle validator (`crates/mc-host/src/synapse/bundle.rs`), and a second
    // implementation here would be free to disagree with it — the useful version of
    // full semantic validation is running that validator over these bytes on the
    // qualifying host, not restating its rules in TypeScript.
    if (JSON_SHAPED_INPUTS.has(key)) {
        try {
            JSON.parse(readFileSync(path, "utf8"));
        } catch {
            fail(
                `inputs.${key}: verified bytes are not parseable JSON, so the runtime cannot load them`,
            );
        }
    }
}

/**
 * Capabilities the pinned ORT/fastembed closure must not carry. Matched as
 * substrings of each declared feature name so a renamed or versioned spelling
 * (`download-binaries`, `fetch-models`, `cuda-12`) still lands, since the point
 * is to deny a class of behavior rather than an exact feature list.
 *
 * Exported because the same denylist has to be applied to the *resolved* feature
 * graph, which this scan cannot see. Cargo unifies the features selected for a
 * package anywhere in the graph, including from a manifest that is not in this
 * repository at all, so no reading of `crates/mc-host/Cargo.toml` can bound the
 * effective closure — only `cargo metadata` can, and it needs a resolvable
 * workspace and a toolchain the portable drift check must not require. The
 * release-script test suite runs where both exist and asserts it there.
 */
export const FORBIDDEN_RUNTIME_FEATURE_SUBSTRINGS = [
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
 * Walk `line`'s characters that lie outside TOML strings, carrying multi-line
 * string state across lines.
 *
 * One walk serves both the comment stripper and the nesting counter, because they
 * have to agree on what a string is. When they did not, the stripper removed a
 * closing `"""` that sat behind a `#` and the counter then read the rest of the file
 * as string body — the two answers were derived from separate scans, so nothing
 * forced them to match.
 *
 * `visit` is called with each unquoted character and its offset; returning `false`
 * stops the walk, which is how the stripper reports the comment it found. The state
 * is the caller's because a multi-line string's close may be lines away.
 */
function scanUnquoted(
    line: string,
    state: { multiline: string | null },
    visit: (char: string, index: number) => boolean,
): void {
    let index = 0;
    while (index < line.length) {
        if (state.multiline !== null) {
            const close = line.indexOf(state.multiline, index);
            if (close === -1) return;
            index = close + state.multiline.length;
            state.multiline = null;
            continue;
        }
        const rest = line.slice(index);
        const opener = rest.startsWith('"""')
            ? '"""'
            : rest.startsWith("'''")
              ? "'''"
              : null;
        if (opener !== null) {
            state.multiline = opener;
            index += opener.length;
            continue;
        }
        const char = line[index] as string;
        if (char === '"' || char === "'") {
            // Single-line string: consume to its close, honouring escapes in a basic
            // string. An unterminated one ends at the line.
            let scan = index + 1;
            let escaped = false;
            for (; scan < line.length; scan++) {
                const inner = line[scan];
                if (char === "'") {
                    if (inner === "'") break;
                    continue;
                }
                if (escaped) escaped = false;
                else if (inner === "\\") escaped = true;
                else if (inner === '"') break;
            }
            index = scan + 1;
            continue;
        }
        if (!visit(char, index)) return;
        index++;
    }
}

/**
 * Strip TOML comments from one line, leaving `#` inside a quoted value alone.
 *
 * Comments are the one place a `Cargo.toml` can contain text that reads exactly
 * like a declaration but means nothing: a commented `version = "=2.0.0-rc.13"`
 * inside a multiline features array would otherwise satisfy a textual check while
 * Cargo resolves whatever the real key says. Removing them before any comparison
 * closes that for every check at once, rather than per pattern.
 *
 * Multi-line-string aware, and the state is the caller's for that reason. A closing
 * delimiter may sit behind a `#` — `value = """` then `# """` is a valid value whose
 * second line begins with one — and stripping that line in isolation deleted the
 * close, leaving every scan's string state open for the rest of the file. With the
 * eligibility rule that a line inside a string is not structure, that silently
 * skipped every table after it.
 */
function stripTomlComments(
    line: string,
    state: { multiline: string | null },
): string {
    let comment = -1;
    scanUnquoted(line, state, (char, index) => {
        if (char !== "#") return true;
        comment = index;
        return false;
    });
    return comment === -1 ? line : line.slice(0, comment);
}

/**
 * Split `cargo` into comment-stripped lines.
 *
 * One state object threaded across the whole file, since a multi-line string spans
 * lines. `Array.map(stripTomlComments)` cannot express this: `map` passes the index
 * as the second argument, which would silently become the state.
 */
function tomlLines(cargo: string): string[] {
    const state = { multiline: null as string | null };
    return cargo.split("\n").map((line) => stripTomlComments(line, state));
}

/**
 * The key text of an assignment, up to the first `=` outside quotes, or `null` when
 * the line holds no assignment.
 *
 * A quoted key may contain `=` — `target.'cfg(target_os = "linux")'.dependencies.ort`
 * is one key — so splitting on the first `=` anywhere truncates it to
 * `target.'cfg(target_os `, which is neither the real key nor recognizable as
 * mentioning a dependency table. Structure is only structure outside strings here
 * too.
 */
function assignmentKeyText(line: string): string | null {
    let quote: string | null = null;
    let escaped = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (quote !== null) {
            if (quote === '"') {
                if (escaped) escaped = false;
                else if (char === "\\") escaped = true;
                else if (char === '"') quote = null;
            } else if (char === "'") {
                quote = null;
            }
            continue;
        }
        if (char === '"' || char === "'") quote = char;
        else if (char === "=") return line.slice(0, i);
    }
    return null;
}

/**
 * Normalize a TOML table header to its dotted form, collapsing the whitespace TOML
 * permits around dots.
 *
 * `[target . 'cfg(...)' . dependencies]` is the same table as
 * `[target.'cfg(...)'.dependencies]`, so a suffix test on the raw text classifies it
 * as something other than a dependency table and every declaration inside goes
 * unexamined. Whitespace is collapsed only outside quotes, since a quoted key may
 * legitimately contain dots and spaces of its own.
 */
function normalizeTableHeader(header: string): string {
    let out = "";
    let quote: string | null = null;
    let escaped = false;
    for (const char of header) {
        if (quote !== null) {
            out += char;
            if (quote === '"') {
                if (escaped) escaped = false;
                else if (char === "\\") escaped = true;
                else if (char === '"') quote = null;
            } else if (char === "'") {
                quote = null;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            out += char;
            continue;
        }
        out += char;
    }
    // Collapse only in the unquoted spans, which is what splitting on quotes gives.
    return out
        .split(/(\'[^']*\'|"(?:[^"\\]|\\.)*")/)
        .map((part, index) =>
            index % 2 === 1 ? part : part.replace(/\s*\.\s*/g, ".").trim(),
        )
        .join("");
}

/** Regex-escape a literal so a version's dots cannot match arbitrary characters. */
function escapeRegex(literal: string): string {
    return literal.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/**
 * Match `key = <value>` in a joined inline entry, anchored to a key boundary.
 *
 * Every key in a dependency entry is a suffix of some other name a manifest may
 * legally carry: `features` sits inside `default-features`, and `default-features`,
 * `version`, and `package` all sit inside a `fake…` decoy Cargo tolerates as an
 * unused key. An unanchored match reads the decoy and reports on it, so key lookups
 * go through one anchored constructor rather than each site remembering the
 * boundary — three of them did, one did not, and that is the bug this removes.
 */
function tomlKeyPattern(key: string, value: string): RegExp {
    const bare = escapeRegex(key);
    // A key inside an inline table is a TOML key like any other, so it may be
    // quoted: Cargo reads `"features" = ["cuda"]` exactly as it reads the bare
    // spelling. Matching only the bare one meant both the presence test and the
    // extraction missed the array, so its accelerator was never examined — and a
    // quoted `"package"` concealed a rename the same way.
    const spelling = `(?:${bare}|"${bare}"|'${bare}')`;
    return new RegExp(`(?:^|[\\s,{])${spelling}\\s*=\\s*${value}`);
}

/**
 * A quoted key carrying a backslash escape, which is the one spelling
 * `tomlKeyPattern` cannot represent.
 *
 * `"featu\u0072es"` is `features` to Cargo, and a pattern over literal spellings
 * cannot decode it, so an entry holding one is refused rather than examined with the
 * key treated as absent. The refusal direction is what matters: a hidden `features`
 * array or `package` rename is exactly the declaration that must not pass.
 */
const ESCAPED_TOML_KEY = /(?:^|[\s,{])"[^"]*\\[^"]*"\s*=/;

/**
 * The net brace and bracket nesting a line opens or closes, ignoring quoted text.
 *
 * Counting every character treats a bracket inside a string as structure, so a
 * valid `poison = "["` leaves the depth permanently positive and every line after
 * it — including a later target-specific dependency — is read as nested content and
 * skipped. Structure is only structure outside strings.
 *
 * Basic and literal strings on one line, which is what Cargo dependency and feature
 * values are; a multi-line `"""` string would need the parser this scan is not.
 */
function structuralDelta(
    line: string,
    state: { multiline: string | null },
): number {
    let delta = 0;
    scanUnquoted(line, state, (char) => {
        if (char === "{" || char === "[") delta++;
        else if (char === "}" || char === "]") delta--;
        return true;
    });
    return delta;
}

/**
 * True when a normalized dotted key path contains a component matching `names`.
 *
 * A dotted assignment is a table declaration: `patch.crates-io.ort = { path = ... }`,
 * `features.default = ["ort/cuda"]`, and
 * `target.'cfg(...)'.dependencies.ort_cuda = { package = "ort" }` all create the table
 * their prefix names, before any header and with whatever whitespace TOML allows
 * around the dots. A scan that only reacts to headers reads none of them.
 *
 * Used to refuse those forms rather than model them: each scan here reasons about a
 * specific table, and an assignment that reaches into one without a header is a
 * declaration the scan cannot attribute. The table form is always available to
 * whoever needs to express it.
 */
function dottedKeyTouches(keyText: string, names: readonly RegExp[]): boolean {
    const normalized = normalizeTableHeader(keyText);
    if (!normalized.includes(".")) return false;
    return splitDottedKey(normalized).some((part) => {
        const name = resolveTomlName(part);
        // A component this scan cannot read cannot be ruled out as one of `names`:
        // `"patch"."crates-io"."ort" = { path = "fake-ort" }` declares the override
        // table under a quoted spelling Cargo resolves, and testing the raw
        // component against a bare-name pattern matched nothing. Callers use this to
        // refuse an assignment they cannot attribute, so unreadable answers yes.
        if (name === null) return true;
        return names.some((candidate) => candidate.test(name));
    });
}

/**
 * The components of a normalized dotted key path, each resolved to the name Cargo
 * will see, or `null` when any component uses a spelling this scan refuses.
 */
function resolveDottedPath(normalized: string): string[] | null {
    const resolved: string[] = [];
    for (const part of splitDottedKey(normalized)) {
        const name = resolveTomlName(part);
        if (name === null) return null;
        resolved.push(name);
    }
    return resolved;
}

/**
 * Split a normalized dotted key path into its components, on the dots outside
 * quotes only.
 *
 * A quoted component may contain dots of its own: `[replace."ort:2.0.0-rc.13"]` is
 * a two-component path whose second component is one package-ID spec, and a plain
 * `split(".")` shreds it into five whose last is `13"`. Bare Cargo table names carry
 * no dots, which is why only the version-bearing `[replace]` key needs this.
 */
function splitDottedKey(normalized: string): string[] {
    const parts: string[] = [];
    let current = "";
    let quote: string | null = null;
    let escaped = false;
    for (const char of normalized) {
        if (quote !== null) {
            current += char;
            if (quote === '"') {
                if (escaped) escaped = false;
                else if (char === "\\") escaped = true;
                else if (char === '"') quote = null;
            } else if (char === "'") {
                quote = null;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            current += char;
            continue;
        }
        if (char === ".") {
            parts.push(current);
            current = "";
            continue;
        }
        current += char;
    }
    parts.push(current);
    return parts;
}

/**
 * Resolve a TOML key or string value as written to the name Cargo will see, or
 * `null` when this scan cannot say. Used for dependency keys, a renamed
 * dependency's `package` value, and forwarded feature values in `[features]` —
 * all three are the same three spellings with the same reason to refuse a fourth.
 *
 * `null` is a refusal, not an absence. A quoted key is a basic string and may
 * carry escapes — `"o\u0072t"` is `ort` to Cargo — so a scan that treats any
 * spelling it does not understand as "some other key" would skip the declaration
 * entirely, which is how a target-specific entry with an accelerator feature could
 * go unexamined while the base entry validated cleanly. Callers must treat `null`
 * as an unreadable dependency table.
 */
function resolveTomlName(raw: string): string | null {
    const key = raw.trim();
    // Bare keys: letters, digits, underscore, dash.
    if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
    // Literal strings take no escapes, so the contents are the name verbatim.
    const literal = /^'([^']*)'$/.exec(key);
    if (literal !== null) return literal[1] ?? null;
    // Basic strings without a backslash need no decoding.
    const basic = /^"([^"\\]*)"$/.exec(key);
    if (basic !== null) return basic[1] ?? null;
    // Anything else — an escaped basic string, a dotted key, a spelling not
    // covered above — is refused rather than guessed at.
    return null;
}

/**
 * Every TOML string token in `entry`, quotes included, or `null` when one is
 * unterminated.
 *
 * Returned with quotes so `resolveTomlName` can apply the same refuse-the-fourth-
 * spelling rule it applies to keys: a basic string carrying escapes is refused
 * rather than decoded, which is what keeps `["ort/c\u0075da"]` from reading as an
 * unrecognized value and slipping past the forwarding filter.
 */
function tomlStringTokens(entry: string): string[] | null {
    const tokens: string[] = [];
    for (let i = 0; i < entry.length; i++) {
        const quote = entry[i];
        if (quote !== '"' && quote !== "'") continue;
        let j = i + 1;
        let escaped = false;
        for (; j < entry.length; j++) {
            const char = entry[j];
            if (quote === "'") {
                if (char === "'") break;
                continue;
            }
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') break;
        }
        if (j >= entry.length) return null;
        tokens.push(entry.slice(i, j + 1));
        i = j;
    }
    return tokens;
}

/**
 * A resolved table-path component naming a dependency table Cargo unifies features
 * from: the base table, or its dev, build, and target-specific variants.
 *
 * Matched against one resolved component rather than the raw path, since a header
 * component is a TOML key and `["dependencies"]` names the same table as
 * `[dependencies]`.
 */
const DEPENDENCY_TABLE = /^(?:dev-|build-)?dependencies$/;

/**
 * One dependency declaration, resolved to the crate Cargo will actually fetch.
 */
interface DependencyDeclaration {
    /** The table it appeared in, e.g. `dependencies` or `target.'cfg(...)'.dependencies`. */
    section: string;
    /** The key as declared, which is what Cargo feature forwarding names. */
    key: string;
    /** `package = "..."` when the dependency is renamed, otherwise the key. */
    crate: string;
    /** The complete inline entry, comments stripped, joined onto one line. */
    entry: string;
}

/**
 * Enumerate every dependency declaration in `Cargo.toml`, resolved to the crate
 * each one actually names.
 *
 * The resolved identity is the point. A dependency key is not a crate name: Cargo
 * lets `ort_cuda = { package = "ort", features = ["cuda"] }` declare the same crate
 * under another key and unifies its features with the ordinary `ort` entry, so a
 * scan comparing keys would leave that declaration unexamined while the safe entry
 * validated cleanly.
 *
 * Returns `null` when any dependency table holds a key or a `package` value this
 * scan cannot read. That refusal is deliberate: a declaration whose identity is
 * unreadable is exactly the one that must not pass unexamined, so the whole file is
 * rejected rather than a subset validated. `null` also covers an unbalanced entry.
 *
 * Section tracking covers every table Cargo unifies features from — base, dev,
 * build, and target-specific — and deliberately reads declarations outside them
 * too, so a decoy under `[package.metadata.qualification]` is attributed to its own
 * section rather than mistaken for a dependency.
 *
 * This is a scan, not a TOML parser. Every shape it cannot account for fails, so
 * being wrong costs a false rejection with an actionable message rather than a
 * false qualification. Brace and bracket counting suffices because Cargo
 * dependency values are versions, paths, and URLs, none of which contain them.
 */
function dependencyDeclarations(
    cargo: string,
): DependencyDeclaration[] | null {
    const lines = tomlLines(cargo);
    const declarations: DependencyDeclaration[] = [];
    // `[dependencies.ort]` and `[target.'cfg(...)'.dependencies.ort]` declare a
    // crate through a subtable rather than an inline value, so the crate name is in
    // the header and its keys are ordinary assignments beneath it. Accumulate those
    // into the same entry shape an inline table produces — `version = "..."`,
    // `default-features = false`, `features = [...]`, `package = "..."` — so every
    // check downstream applies to both spellings unchanged.
    let open: { section: string; key: string; body: string[] } | null = null;
    const closeSubtable = (): boolean => {
        if (open === null) return true;
        const { section: parent, key, body } = open;
        open = null;
        const entry = body.join(" ");
        const crate = resolveRenamedCrate(key, entry);
        if (crate === null) return false;
        declarations.push({ section: parent, key, crate, entry });
        return true;
    };
    let section = "";
    let inDependencyTable = false;
    let depth = 0;
    const stringState = { multiline: null as string | null };
    for (const [index, line] of lines.entries()) {
        const trimmed = line.trim();
        // A line that starts inside an open multi-line string is not structure: a
        // `poison = """\n[package.metadata.decoy]\n"""` value would otherwise read as
        // a real header and close the dependency subtable early, dropping every key
        // Cargo still counts below it — `features` included — from the scanned entry.
        const atTopLevel = depth === 0 && stringState.multiline === null;
        depth += structuralDelta(line, stringState);
        // A `[...]` line is only a section header at top level; inside a multiline
        // array it is array syntax.
        const header = atTopLevel ? /^\[([^\]]+)\]$/.exec(trimmed) : null;
        if (header !== null) {
            if (!closeSubtable()) return null;
            // Resolved before it is classified: a header component is a TOML key, so
            // `["dependencies"]` and `[target.'cfg(...)'."dependencies"]` name the
            // ordinary dependency tables Cargo unifies features from. Testing the raw
            // suffix attributed them elsewhere and every declaration inside — a
            // renamed `ort` among them — went unexamined.
            const parts = resolveDottedPath(normalizeTableHeader(header[1] ?? ""));
            if (parts === null) return null;
            section = parts.join(".");
            const last = parts[parts.length - 1] ?? "";
            inDependencyTable = DEPENDENCY_TABLE.test(last);
            if (
                parts.length >= 2 &&
                DEPENDENCY_TABLE.test(parts[parts.length - 2] ?? "")
            ) {
                open = {
                    section: parts.slice(0, -1).join("."),
                    key: last,
                    body: [],
                };
            }
            continue;
        }
        // Accumulate the whole subtable, nested array lines included: skipping them
        // for being below top level would truncate `features = [` into an entry the
        // feature check then reports as unreadable, rejecting a valid manifest.
        if (open !== null) {
            if (trimmed !== "") open.body.push(trimmed);
            continue;
        }
        if (!atTopLevel) continue;
        const keyText = assignmentKeyText(trimmed);
        if (keyText === null) continue;
        const key = resolveTomlName(keyText);
        if (key === null) {
            // A dotted assignment creates its own table:
            // `target.'cfg(...)'.dependencies.ort_cuda = { package = "ort" }` is a
            // dependency declaration wherever it appears, including before the first
            // header where `section` is still empty. The key is unreadable to this
            // scan either way, so a key that mentions `dependencies` refuses the file
            // rather than being skipped as unrelated.
            if (
                inDependencyTable ||
                dottedKeyTouches(keyText, [/^[^.]*dependencies$/])
            ) {
                return null;
            }
            continue;
        }
        const entry = joinInlineEntry(lines, index);
        if (entry === null) {
            if (inDependencyTable) return null;
            continue;
        }
        const crate = inDependencyTable
            ? resolveRenamedCrate(key, entry)
            : key;
        if (crate === null) return null;
        declarations.push({ section, key, crate, entry });
    }
    if (!closeSubtable()) return null;
    return declarations;
}

/** The crate a declaration resolves to: `package = "..."` when renamed, else the
 *  key. `null` when a `package` value is present but unreadable, or when the entry
 *  spells any key in a way this scan cannot resolve — a concealed `package` is
 *  indistinguishable from an absent one, so an unreadable key spelling refuses. */
function resolveRenamedCrate(key: string, entry: string): string | null {
    if (ESCAPED_TOML_KEY.test(entry)) return null;
    if (!tomlKeyPattern("package", "").test(entry)) return key;
    const renamed = tomlKeyPattern("package", `("[^"\\\\]*"|'[^']*')`).exec(entry);
    return resolveTomlName(renamed?.[1] ?? "");
}

/**
 * A package-ID spec, as `[replace]` keys are written: an optional source, then the
 * package name and version.
 *
 * The version must not reach a path, fragment, or query separator, which is what
 * keeps a source URL from matching with `https` as its name.
 */
const PACKAGE_ID_SPEC = /^([A-Za-z0-9_-]+)(?:[@:][^/#?]*)?$/;

/**
 * The crate a `[replace]` key names, or `null` when this scan cannot say.
 *
 * A `[replace]` key is a package-ID spec rather than a bare crate name, and Cargo
 * accepts several spellings of one: `ort:2.0.0-rc.13`, the modern
 * `ort@2.0.0-rc.13`, and a source URL carrying the package in its fragment
 * (`https://github.com/pykeio/ort#ort:2.0.0-rc.13`). Cutting the spec at its first
 * `:` reads only the first — the `@` form keeps its version attached and the URL
 * form reduces to `https`, so both were compared against the qualified crates under
 * a name no crate has and passed as overrides of something unrelated.
 *
 * A spec that never writes its package down — a bare source URL, or one whose
 * fragment holds only a version, where Cargo derives the name from the source
 * itself — returns `null` so the caller refuses the manifest instead of guessing.
 */
function replacedCrateName(spec: string): string | null {
    const trimmed = spec.trim();
    const bare = PACKAGE_ID_SPEC.exec(trimmed);
    if (bare !== null) return bare[1] ?? null;
    const hash = trimmed.indexOf("#");
    if (hash === -1) return null;
    const fragment = PACKAGE_ID_SPEC.exec(trimmed.slice(hash + 1).trim());
    const named = fragment?.[1];
    // A fragment may hold a version instead of a package (`…/ort#2.0.0-rc.13`),
    // which leaves the name implicit in the source this scan does not resolve.
    if (named === undefined || !/^[A-Za-z_]/.test(named)) return null;
    return named;
}

/** Join the inline entry starting at `index` onto one line, or `null` when its
 *  braces and brackets never balance. */
function joinInlineEntry(lines: string[], index: number): string | null {
    const collected: string[] = [];
    let depth = 0;
    const stringState = { multiline: null as string | null };
    for (let i = index; i < lines.length; i++) {
        const line = lines[i] ?? "";
        collected.push(line.trim());
        depth += structuralDelta(line, stringState);
        if (depth <= 0) return collected.join(" ");
    }
    return null;
}

/**
 * Extract `crate`'s complete inline dependency entry from the `[dependencies]`
 * table of `Cargo.toml`.
 *
 * Returns `null` unless the crate is declared exactly once in the whole file — by
 * resolved identity, so a rename counts — and that declaration is in
 * `[dependencies]`. Requiring uniqueness is what stops a second declaration under
 * a target-specific table, or under another key via `package`, contributing
 * features this check never sees. `null` also covers the absent, unreadable, and
 * `[dependencies.<crate>]` section forms; callers must fail closed on it rather
 * than read it as "declares nothing".
 */
function inlineDependencyEntry(cargo: string, crate: string): string | null {
    const declarations = dependencyDeclarations(cargo);
    if (declarations === null) return null;
    const matches = declarations.filter((d) => d.crate === crate);
    if (matches.length !== 1) return null;
    const only = matches[0] as DependencyDeclaration;
    return only.section === "dependencies" ? only.entry : null;
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
    // Anchored: `fakeversion = "=<pin>"` contains the literal a substring test looks
    // for, so a decoy key could satisfy the pin while the real one differs.
    if (!tomlKeyPattern("version", `"=${escapeRegex(version)}"`).test(entry)) {
        fail(
            `pinned ${crate} identity does not match ${MC_HOST_CARGO_TOML_PATH}`,
        );
    }
    if (!tomlKeyPattern("default-features", "false").test(entry)) {
        fail(
            `${crate} in ${MC_HOST_CARGO_TOML_PATH} must set default-features = false`,
        );
    }
    // One anchored pattern for both the presence test and the extraction. A
    // boundary is required because `features` is a suffix of other keys —
    // `default-features` legitimately, `fakefeatures` as a decoy whose array an
    // unanchored extraction would read instead of the real one. Using two patterns
    // is what let presence be anchored while extraction was not.
    const FEATURES_KEY = tomlKeyPattern("features", "");
    const declared = tomlKeyPattern("features", "\\[([^\\]]*)\\]").exec(entry);
    if (FEATURES_KEY.test(entry) && declared === null) {
        fail(
            `${crate} in ${MC_HOST_CARGO_TOML_PATH} declares a features list this qualifier cannot read`,
        );
    }
    // Same string rule as the `[features]` forwarding scan: stripping quotes is not
    // reading a TOML string, and `"c\u0075da"` decodes to a forbidden feature that
    // an undecoded substring test cannot see.
    const tokens = tomlStringTokens(declared?.[1] ?? "");
    if (tokens === null) {
        fail(
            `${crate} in ${MC_HOST_CARGO_TOML_PATH} declares a features list holding an unterminated string`,
        );
    }
    for (const token of tokens) {
        const resolved = resolveTomlName(token);
        if (resolved === null) {
            fail(
                `${crate} in ${MC_HOST_CARGO_TOML_PATH} declares a feature this qualifier cannot read (${token})`,
            );
        }
        const feature = resolved.toLowerCase();
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
 * the workspace does not itself depend on the package, or the package is not
 * resolved, so callers fail closed instead of accepting an unverified version.
 * The declaration check is what makes the hoisted fallback safe: without it, a
 * workspace that stopped depending on the package at all would still qualify
 * whatever version some unrelated workspace or transitive dependency left hoisted.
 */
function resolveLockedVersion(
    lockText: string,
    workspace: string,
    pkg: string,
): string | null {
    let lock: {
        packages?: Record<string, unknown>;
        workspaces?: Record<string, Record<string, unknown>>;
    };
    try {
        lock = JSON.parse(stripJsoncTrailingCommas(lockText));
    } catch {
        return null;
    }
    const packages = lock.packages;
    if (packages === null || typeof packages !== "object") return null;
    const importer = lock.workspaces?.[workspace];
    if (importer === null || typeof importer !== "object") return null;
    const consumer = importer.name;
    if (typeof consumer !== "string" || consumer.length === 0) return null;
    const declared = [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
    ].some((table) => {
        const entries = importer[table];
        return (
            entries !== null &&
            typeof entries === "object" &&
            pkg in (entries as Record<string, unknown>)
        );
    });
    if (!declared) return null;
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

/**
 * Reject a `[features]` entry that forwards a forbidden capability to a qualified
 * crate.
 *
 * Cargo's feature table enables a dependency's feature with `dep/feature`, so a
 * closure claim checked only against dependency entries is defeated from the other
 * side: `[features] default = ["ort/cuda"]` enables CUDA for every build that does
 * not pass `--no-default-features`, which `build:rust` does not.
 *
 * Every entry in the table is scanned, not only the ones reachable from `default`.
 * A forwarding declared under an unreachable feature name still contradicts the
 * closure the lock publishes, and feature reachability is exactly the resolution
 * this scan declines to approximate.
 *
 * Forwarding names the dependency *key*, so a renamed dependency forwards under its
 * rename. The key set therefore comes from the resolved declarations rather than
 * from the crate names.
 */
function assertNoForbiddenFeatureForwarding(
    cargo: string,
    declarations: DependencyDeclaration[],
    crates: readonly string[],
): void {
    const keys = new Set(
        declarations
            .filter((declaration) => crates.includes(declaration.crate))
            .map((declaration) => declaration.key),
    );
    if (keys.size === 0) return;
    const lines = tomlLines(cargo);
    let section = "";
    let depth = 0;
    const stringState = { multiline: null as string | null };
    for (const [index, line] of lines.entries()) {
        const trimmed = line.trim();
        // A line that starts inside an open multi-line string is not structure: its
        // content would otherwise read as a real header and reattribute every line
        // after it, which is enough to move a declaration out of the table this scan
        // is examining.
        const atTopLevel = depth === 0 && stringState.multiline === null;
        depth += structuralDelta(line, stringState);
        if (!atTopLevel) continue;
        const header = /^\[([^\]]+)\]$/.exec(trimmed);
        if (header !== null) {
            // Resolved before it is compared, for the reason the dependency scan
            // resolves its own headers: a header component is a TOML key, so
            // `["features"]` names the same table as `[features]`, and comparing the
            // raw text left the whole forwarding table unexamined.
            const parts = resolveDottedPath(normalizeTableHeader(header[1] ?? ""));
            if (parts === null) {
                fail(
                    `${MC_HOST_CARGO_TOML_PATH} declares a table header this qualifier cannot read, so a forbidden feature forwarding cannot be ruled out`,
                );
            }
            section = parts.join(".");
            continue;
        }
        const keyText = assignmentKeyText(trimmed);
        if (keyText === null) continue;
        if (section !== "features") {
            // `features.default = ["ort/cuda"]` declares the same table without a
            // header, so a header-only scan never sees the forwarding.
            if (dottedKeyTouches(keyText, [/^features$/])) {
                fail(
                    `${MC_HOST_CARGO_TOML_PATH} declares a dotted features assignment this qualifier cannot attribute; use the [features] table`,
                );
            }
            continue;
        }
        const entry = joinInlineEntry(lines, index);
        if (entry === null) {
            fail(
                `the [features] table in ${MC_HOST_CARGO_TOML_PATH} holds an entry this qualifier cannot read`,
            );
        }
        const tokens = tomlStringTokens(entry);
        if (tokens === null) {
            fail(
                `the [features] table in ${MC_HOST_CARGO_TOML_PATH} holds an unterminated string`,
            );
        }
        for (const token of tokens) {
            const value = resolveTomlName(token);
            if (value === null) {
                fail(
                    `the [features] table in ${MC_HOST_CARGO_TOML_PATH} holds a string this qualifier cannot read (${token})`,
                );
            }
            // `dep?/feature` is the weak form; both forward the same capability.
            const forward = /^([A-Za-z0-9_-]+)\??\/(.+)$/.exec(value);
            const key = forward?.[1];
            const feature = forward?.[2]?.toLowerCase();
            if (key === undefined || feature === undefined) continue;
            if (!keys.has(key)) continue;
            const forbidden = FORBIDDEN_RUNTIME_FEATURE_SUBSTRINGS.find((hint) =>
                feature.includes(hint),
            );
            if (forbidden !== undefined) {
                fail(
                    `the [features] table in ${MC_HOST_CARGO_TOML_PATH} forwards ${value}, which is outside the qualified closure (${forbidden})`,
                );
            }
        }
    }
}

/**
 * Reject a workspace `[patch]` or `[replace]` override that could redirect a
 * qualified crate.
 *
 * Cargo resolves overrides from the workspace root, so a leaf manifest can name the
 * exact pin while the build compiles a replacement source entirely. No reading of
 * `crates/mc-host/Cargo.toml` can see that.
 *
 * This refuses rather than resolves: an override naming a qualified crate — or a
 * `[patch]` table this scan cannot attribute — fails the qualification instead of
 * being followed. Following it means resolving the workspace graph through
 * `cargo metadata`, which needs a toolchain the portable drift check must not
 * require; that is the escalation if overrides ever become legitimate here, not a
 * further textual rule.
 */
function assertNoQualifiedCrateOverride(
    rootDir: string,
    crates: readonly string[],
): void {
    const path = join(rootDir, WORKSPACE_CARGO_TOML_PATH);
    if (!existsSync(path)) {
        fail(
            `${WORKSPACE_CARGO_TOML_PATH} is required to rule out an override of the qualified crates`,
        );
    }
    // Annotated rather than inferred: a call only narrows away the `null` the
    // checks below refuse when the callee is a const of an explicit `never`-returning
    // type, so without the annotation the compiler stops enforcing exactly the
    // refusals this scan depends on.
    const unreadable: () => never = () =>
        fail(
            `${WORKSPACE_CARGO_TOML_PATH} declares an override this qualifier cannot read, so the qualified crate identities cannot be ruled out`,
        );
    const reject = (crate: string): void => {
        if (crates.includes(crate)) {
            fail(
                `${WORKSPACE_CARGO_TOML_PATH} overrides ${crate}, so the build would not resolve the qualified crate identity`,
            );
        }
    };
    const lines = tomlLines(readFileSync(path, "utf8"));
    // Which override table the scan is inside, resolved rather than matched against
    // the header text: a table name is a TOML key, so `["replace"]` and
    // `[replace]` are the same table and Cargo applies both. Comparing the text left
    // every quoted or escaped spelling unattributed and therefore unexamined.
    let override: "patch" | "replace" | null = null;
    let depth = 0;
    const stringState = { multiline: null as string | null };
    // `[patch.<registry>.<crate>]` and `[replace.<package-id>]` name their crate in
    // the header, and a `package` rename would be an assignment inside the body, so
    // the verdict cannot be reached until the body ends. Deciding it from assignment
    // lines instead read `path` as the crate name and only reached the header's crate
    // on a non-assignment line — so a subtable that ran to EOF without a trailing
    // blank line was never checked.
    let openCrate: string | null = null;
    let openBody: string[] = [];
    const closeSubtable = (): void => {
        if (openCrate === null) return;
        const key = openCrate;
        const entry = openBody.join(" ");
        openCrate = null;
        openBody = [];
        const resolved = resolveRenamedCrate(key, entry);
        if (resolved === null) unreadable();
        reject(resolved);
    };
    for (const [index, line] of lines.entries()) {
        const trimmed = line.trim();
        // A line that starts inside an open multi-line string is not structure: its
        // content would otherwise read as a real header and reattribute every line
        // after it, which is enough to move a declaration out of the table this scan
        // is examining.
        const atTopLevel = depth === 0 && stringState.multiline === null;
        depth += structuralDelta(line, stringState);
        if (!atTopLevel) continue;
        const header = /^\[([^\]]+)\]$/.exec(trimmed);
        if (header !== null) {
            closeSubtable();
            // Resolved before it is compared: a header component is a TOML key, so
            // `["\u0072eplace"."ort:2.0.0-rc.13"]` and `["patch"."crates-io"."ort"]`
            // spell the override tables in ways Cargo resolves and a raw comparison
            // does not, leaving the whole table unattributed and unexamined. An
            // unreadable component cannot be ruled out as one of them.
            const parts = resolveDottedPath(normalizeTableHeader(header[1] ?? ""));
            if (parts === null) unreadable();
            const root = parts[0] ?? "";
            override = root === "patch" || root === "replace" ? root : null;
            if (override === null) continue;
            // `[patch.<registry>]` and `[replace]` hold one assignment per overridden
            // crate; a longer path names the crate in its own subtable.
            const subtable =
                (override === "patch" && parts.length >= 3) ||
                (override === "replace" && parts.length >= 2);
            if (!subtable) continue;
            const last = parts[parts.length - 1] ?? "";
            // A `[replace]` subtable is keyed by a package-ID spec, a `[patch]` one by
            // the crate name.
            const named = override === "replace" ? replacedCrateName(last) : last;
            if (named === null) unreadable();
            openCrate = named;
            continue;
        }
        if (openCrate !== null) {
            if (trimmed !== "") openBody.push(trimmed);
            continue;
        }
        if (override === null) {
            // `patch.crates-io.ort = { path = "fake-ort" }` is an override declared
            // without a header, including before `[workspace]`.
            const dotted = assignmentKeyText(trimmed);
            if (
                dotted !== null &&
                dottedKeyTouches(dotted, [/^patch$/, /^replace$/])
            ) {
                fail(
                    `${WORKSPACE_CARGO_TOML_PATH} declares a dotted override assignment this qualifier cannot attribute; use the [patch] table`,
                );
            }
            continue;
        }
        const keyText = assignmentKeyText(trimmed);
        if (keyText === null) continue;
        const key = resolveTomlName(keyText);
        if (key === null) unreadable();
        // A `[replace]` key is a package-ID spec, not a bare crate name.
        const crate = override === "replace" ? replacedCrateName(key) : key;
        if (crate === null) unreadable();
        const entry = joinInlineEntry(lines, index);
        if (entry === null) unreadable();
        // A patch entry renames the same way a dependency does:
        // `ort_fork = { package = "ort", path = "..." }` overrides `ort`, so the key
        // is not the crate.
        const resolved = resolveRenamedCrate(crate, entry);
        if (resolved === null) unreadable();
        reject(resolved);
    }
    closeSubtable();
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
        const qualified = [
            ["fastembed", RUNTIME_IDENTITY.rust_crates.fastembed],
            ["ort", RUNTIME_IDENTITY.rust_crates.ort],
        ] as const;
        for (const [crate, version] of qualified) {
            assertPinnedCrateFeatures(cargo, crate, version);
        }
        // The dependency entries are only one side of the closure: `[features]` can
        // forward a capability to the same crates, so both sides are checked.
        const declarations = dependencyDeclarations(cargo);
        if (declarations === null) {
            fail(
                `${MC_HOST_CARGO_TOML_PATH} holds a dependency declaration this qualifier cannot read`,
            );
        }
        assertNoForbiddenFeatureForwarding(
            cargo,
            declarations,
            qualified.map(([crate]) => crate),
        );
        // The leaf manifest is not the whole answer: an override in the workspace
        // root redirects the crate Cargo actually builds.
        assertNoQualifiedCrateOverride(
            rootDir,
            qualified.map(([crate]) => crate),
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

/**
 * Assert the interpreter running a qualifying pass is the pinned Bun.
 *
 * `harness_runtimes` is otherwise copied into the lock as an assertion nothing
 * corroborates. Binding it to the real interpreter is only meaningful where the
 * qualification actually happens — the host holding the artifacts, which is the host
 * asked to verify bytes.
 *
 * Enforced at the CLI boundary, not inside `generate`. `generate` is driven by tests
 * over synthetic roots and by CI's portable drift check, and a host-environment
 * assertion buried in it would make both depend on the runner's Bun — which is
 * exactly the failure this function's placement exists to avoid.
 *
 * Bun only: the lock pins Node and npm as ranges (`24.x`, `11.x`), so there is no
 * exact value to compare, and identifying them would mean spawning each interpreter.
 */
export function assertPinnedQualifyingRuntime(running: string | undefined): void {
    const pinned = QUALIFICATION_PINS.harness_runtimes.bun;
    if (running !== pinned) {
        fail(
            `byte verification must run under the pinned Bun ${pinned} (running ${String(running)})`,
        );
    }
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function main(): void {
    const args = process.argv.slice(2);
    const check = args.includes("--check");
    const verifyBytes = args.includes("--verify-bytes");
    const requireQualified = args.includes("--require-qualified");
    const unknown = args.filter(
        (arg) =>
            arg !== "--check" &&
            arg !== "--verify-bytes" &&
            arg !== "--require-qualified",
    );
    if (unknown.length > 0) {
        console.error(`unknown arguments: ${unknown.join(" ")}`);
        process.exit(2);
    }
    const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    // Byte verification is the qualifying host's operation, so it is the one place
    // the pinned harness runtime is bound to a real interpreter. The condition has to
    // predict `generate`'s own resolution rather than restate part of it: write mode
    // verifies bytes without being asked, while the consumption gate always regenerates
    // in check mode and so verifies only when explicitly told to. Getting this subset
    // wrong in either direction is a live failure — too narrow and the documented
    // `release:qualify` hashes artifacts unbound, too wide and the gate refuses to run
    // on a host that was never going to read a byte.
    const willVerifyBytes = requireQualified ? verifyBytes : verifyBytes || !check;
    if (willVerifyBytes) {
        try {
            assertPinnedQualifyingRuntime(process.versions?.bun);
        } catch (error) {
            console.error(error instanceof Error ? error.message : String(error));
            process.exit(1);
        }
    }
    // `--check` reports drift and prints the verdict; it exits 0 over unqualified
    // inputs on purpose, because the committed manifest is deliberately unqualified
    // until release engineering records the real bytes, and CI has to stay green in
    // that state. `--require-qualified` is the release prerequisite: it runs the
    // same consumption gate a production build runs, so the gate is reachable
    // outside the tests and a release cannot proceed on an unqualified verdict.
    //
    // The prerequisite pairs with `--verify-bytes` (see `release:qualify:require`),
    // because it runs where the artifacts are: without it the gate proves the
    // committed description is canonical while the bytes about to be packaged could
    // have been replaced, truncated, or removed since qualification.
    if (requireQualified) {
        try {
            const accepted = requireQualificationEvidence(rootDir, {
                verifyBytes: verifyBytes ? true : undefined,
            });
            console.log(
                "mc-host production inputs are qualified " +
                    `(U8 sha256 ${accepted.u8Digest}, lock sha256 ${accepted.lockSha256}, ` +
                    `credentials sha256 ${accepted.credentialsSha256})`,
            );
        } catch (error) {
            console.error(error instanceof Error ? error.message : String(error));
            process.exit(1);
        }
        return;
    }
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
