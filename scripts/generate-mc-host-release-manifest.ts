/**
 * The generator creates the pre-build release and compatibility contract.
 *
 * The generator emits three deterministic, byte-exact outputs from the in-source contract literal.
 *
 *
 * The Rust and TypeScript outputs embed byte-identical canonical JSON and its SHA-256 digest.
 * The pre-build contract contains no binary, model, runtime, or payload hashes; post-build artifacts bind its digest instead.
 *
 * The generator requires a valid local `release/mc-host-registry-gate.json` gate and makes no registry calls.
 * The gate records npm ownership, publisher, credential-revocation, and unpublished-version evidence.
 * An absent or failing gate file blocks generation.
 *
 * Usage:
 * `bun scripts/generate-mc-host-release-manifest.ts` writes the generated outputs.
 * `bun scripts/generate-mc-host-release-manifest.ts --check` fails when any generated output drifts.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// The contract literal is the sole pre-build source of truth.
// ---------------------------------------------------------------------------

/** The registry gate must verify that `0.38.0` is unpublished for all six packages. */
const RELEASE_VERSION = "0.38.0";

const PARENT_PACKAGES = [
    "@cortexkit/magic-context",
    "@cortexkit/opencode-magic-context",
    "@cortexkit/pi-magic-context",
] as const;

const PAYLOAD_PACKAGES = [
    "@cortexkit/mc-host-darwin-arm64",
    "@cortexkit/mc-host-darwin-x64",
    "@cortexkit/mc-host-linux-x64-gnu",
] as const;

/**
 * The shared-memory addon is a non-optional dependency of every parent, so an
 * unpublished or unowned name breaks `npm install` outright rather than
 * degrading one capability. It is not a payload: it carries the loader, not a
 * daemon binary.
 */
const ADDON_PACKAGES = ["@cortexkit/mc-shm-native"] as const;

const CONTRACT = {
    schema: "magic-context.mc-host-release/v1",
    release: {
        id: "mc-host-release",
        version: RELEASE_VERSION,
    },
    packages: {
        parents: [...PARENT_PACKAGES],
        payloads: [...PAYLOAD_PACKAGES],
        addons: [...ADDON_PACKAGES],
        version: RELEASE_VERSION,
    },
    versions: {
        daemon: "mc-host/0.1.0",
        supported_daemon_range: {
            min_inclusive: "0.1.0",
            max_exclusive: "0.2.0",
        },
        modules: {
            broca: {
                version: "0.1.0",
                range: { min_inclusive: "0.1.0", max_exclusive: "0.2.0" },
            },
            magic_context: {
                version: "0.1.0",
                range: { min_inclusive: "0.1.0", max_exclusive: "0.2.0" },
            },
            synapse: {
                version: "0.1.0",
                range: { min_inclusive: "0.1.0", max_exclusive: "0.2.0" },
            },
        },
        wire_protocol: 2,
    },
    proof: {
        // `current_offers` orders proof versions by client preference.
        // Servers on the current proof version accept only offer lists containing `current_version`.
        current_version: 2,
        current_offers: [2],
        // Both current proof MACs bind exactly these transcript fields, in order.
        transcript_fields: [
            "offers",
            "selected_version",
            "daemon_ver",
            "client_nonce",
            "server_nonce",
            "daemon_id",
        ],
        // The trusted N-1 `legacy_stop_only` profile is never negotiated on the general endpoint and does not infer a missing offer.
        legacy_stop_only: {
            version: 1,
            scope: "stop_only",
            adjacent_release_only: true,
            missing_offer_inference: false,
        },
    },
    // The schema reserves a stop-provenance tag for a post-build record.
    stop_provenance_schema: {
        tag_field: "tag",
        tags: ["genesis", "predecessor"],
        genesis: {
            // The post-build binding covers only the current release identity.
            // The post-build binding grants no predecessor, proof, or payload-manifest authority.
            required_fields: ["release_version", "tag"],
            forbidden_fields: [
                "legacy_proof_version",
                "payload_manifest_digest",
                "predecessor_daemon_version",
                "predecessor_manifest",
                "predecessor_release_version",
            ],
            legacy_stop_authority: false,
        },
        predecessor: {
            required_fields: [
                "legacy_proof_version",
                "payload_manifest_digest",
                "predecessor_daemon_version",
                "predecessor_manifest",
                "predecessor_release_version",
                "release_version",
                "tag",
                "target",
            ],
            legacy_stop_authority: true,
        },
    },
    epochs: {
        compartment_render: 2,
        memory_render: 2,
        profile_claude_code_anthropic: 2,
        state_sync: 1,
        tagger: 3,
    },
    platforms: {
        supported: [
            {
                target: "darwin-arm64",
                os_min: "13.5",
                synapse: "unsupported",
                synapse_reason: "synapse_unsupported",
                capabilities: {
                    dev_fd_exec: true,
                    filesystem: [
                        "atomic_same_filesystem_replacement",
                        "cross_process_locks",
                        "file_and_directory_fsync",
                        "local_filesystem",
                        "no_follow_link_semantics",
                        "retained_object_execution",
                    ],
                },
            },
            {
                target: "darwin-x64",
                os_min: "13.5",
                synapse: "unsupported",
                synapse_reason: "synapse_unsupported",
                capabilities: {
                    dev_fd_exec: true,
                    filesystem: [
                        "atomic_same_filesystem_replacement",
                        "cross_process_locks",
                        "file_and_directory_fsync",
                        "local_filesystem",
                        "no_follow_link_semantics",
                        "retained_object_execution",
                    ],
                },
            },
            {
                target: "linux-x64-gnu",
                kernel_min: "4.18",
                glibc_min: "2.28",
                synapse: "certified_cpu",
                capabilities: {
                    procfs_self_fd_exec: true,
                    filesystem: [
                        "atomic_same_filesystem_replacement",
                        "cross_process_locks",
                        "file_and_directory_fsync",
                        "local_filesystem",
                        "no_follow_link_semantics",
                        "retained_object_execution",
                    ],
                },
            },
        ],
        // The fallback applies to musl, below-floor hosts, and Linux without qualified procfs self-fd execution.
        unsupported_reason: "unsupported_platform",
    },
    model_lane: {
        id: "gte-modernbert-base-f16",
        execution_provider: "cpu",
        platforms: ["linux-x64-gnu"],
        unsupported: {
            "darwin-arm64": "synapse_unsupported",
            "darwin-x64": "synapse_unsupported",
        },
    },
    // Supported code never renames or unlinks the version-neutral coordination names.
    coordination: {
        directory: ".mc-host-coordination",
        transaction_lock: "transaction.lock",
        lifetime_lock: "lifetime.lock",
    },
    // Managed data-root layout segments. The Rust daemon and every
    // TypeScript resolver derive `${dataRoot}/cortexkit/...` path names from
    // this one definition, so a rename regenerates every side at once
    // instead of leaving a stale hand-written copy pointing at the old tree.
    layout: {
        managed_subtree: "cortexkit",
        runtime_directory: "run",
        connection_file: "subc-connection.json",
        storage_subdirectory: "magic-context",
    },
    cli: {
        result_schema: "magic-context.daemon/v1",
        commands: ["start", "stop", "restart", "status", "doctor"],
        states: [
            "unavailable",
            "stopped",
            "starting",
            "running",
            "stopping",
            "wedged",
        ],
        check_statuses: ["pass", "fail", "warn", "skip"],
        readiness_states: {
            shared_memory: ["ready", "starting", "unavailable"],
            storage: ["ready", "starting", "unavailable"],
            synapse: ["ready", "starting", "degraded", "unsupported"],
        },
        effects: {
            restart_only: true,
            fields: ["stop_committed", "start_committed"],
        },
        exit_codes: { ok: 0, operational_failure: 1, usage: 2 },
        // The v1 check-ID union is closed and lexicographically sorted.
        check_ids: [
            "artifact.bootstrap",
            "artifact.current_generation",
            "artifact.input_qualification",
            "artifact.native_payload",
            "compatibility.control",
            "compatibility.daemon",
            "compatibility.epochs",
            "compatibility.modules",
            "compatibility.proof",
            "credentials.broca",
            "filesystem.capacity.bootstrap",
            "filesystem.capacity.generation",
            "filesystem.permissions",
            "filesystem.support",
            "install.layout",
            "lifecycle.evidence",
            "lifecycle.fences",
            "lifecycle.publication",
            "platform.support",
            "readiness.shared_memory",
            "readiness.storage",
            "readiness.synapse",
        ],
        // The remediation union is closed.
        remediations: [
            "align_versions",
            "free_storage",
            "inspect_daemon_process",
            "inspect_storage",
            "inspect_synapse",
            "install_native_payload",
            "reinstall_magic_context",
            "report_bug",
            "restart_with_supported_harness",
            "run_daemon_restart",
            "run_daemon_start",
            "set_data_directory",
            "use_supported_install_layout",
            "use_supported_platform",
            "wait_and_retry",
        ],
        reasons: {
            // Fixed precedence order: the first failed row wins for status/doctor.
            // `harness_unavailable` chooses remediation by subreason precedence.
            failing_by_precedence: [
                { id: "internal_error", remediation: "report_bug" },
                { id: "no_data_dir", remediation: "set_data_directory" },
                {
                    id: "unsupported_filesystem",
                    remediation: "set_data_directory",
                },
                {
                    id: "unsupported_platform",
                    remediation: "use_supported_platform",
                },
                {
                    id: "unsupported_install_layout",
                    remediation: "use_supported_install_layout",
                },
                {
                    id: "unsupported_state_schema",
                    remediation: "align_versions",
                },
                {
                    id: "native_payload_invalid",
                    remediation: "reinstall_magic_context",
                },
                {
                    id: "native_payload_missing",
                    remediation: "install_native_payload",
                },
                { id: "insufficient_storage", remediation: "free_storage" },
                {
                    id: "native_probe_unavailable",
                    remediation: "run_daemon_restart",
                },
                { id: "wedged", remediation: "inspect_daemon_process" },
                {
                    id: "publication_invalid",
                    remediation: "inspect_daemon_process",
                },
                {
                    id: "publication_stale",
                    remediation: "inspect_daemon_process",
                },
                {
                    id: "publication_missing",
                    remediation: "inspect_daemon_process",
                },
                {
                    id: "authentication_failed",
                    remediation: "inspect_daemon_process",
                },
                {
                    id: "unsupported_proof_version",
                    remediation: "align_versions",
                },
                { id: "incompatible_control", remediation: "align_versions" },
                { id: "incompatible_daemon", remediation: "align_versions" },
                { id: "incompatible_module", remediation: "align_versions" },
                { id: "incompatible_epochs", remediation: "align_versions" },
                {
                    id: "shutdown_timeout",
                    remediation: "inspect_daemon_process",
                },
                {
                    id: "startup_timeout",
                    remediation: "inspect_daemon_process",
                },
                { id: "lifecycle_busy", remediation: "wait_and_retry" },
                { id: "storage_unavailable", remediation: "inspect_storage" },
                { id: "storage_starting", remediation: "wait_and_retry" },
                { id: "synapse_degraded", remediation: "inspect_synapse" },
                { id: "synapse_starting", remediation: "wait_and_retry" },
                {
                    id: "harness_unavailable",
                    remediation: null,
                    remediation_from_subreason: true,
                },
                { id: "stopping", remediation: "wait_and_retry" },
                { id: "starting", remediation: "wait_and_retry" },
                { id: "not_running", remediation: "run_daemon_start" },
            ],
            non_failing: [
                "already_running",
                "already_stopped",
                "healthy",
                "started",
                "stopped",
                "synapse_unsupported",
            ],
        },
    },
    // Broca unavailability reasons are closed and evaluated in precedence order.
    // Credential value size is checked before aggregate row size.
    harness_unavailable: {
        reasons_by_precedence: [
            {
                id: "descriptor_absent",
                remediation: "restart_with_supported_harness",
            },
            {
                id: "descriptor_invalid",
                remediation: "restart_with_supported_harness",
            },
            {
                id: "closure_incomplete",
                remediation: "restart_with_supported_harness",
            },
            {
                id: "argument_variant_invalid",
                remediation: "restart_with_supported_harness",
            },
            { id: "provider_unsupported", remediation: null },
            { id: "auth_mechanism_unsupported", remediation: null },
            {
                id: "credential_missing",
                remediation: "restart_with_supported_harness",
            },
            {
                id: "credential_value_too_large",
                remediation: "restart_with_supported_harness",
            },
            {
                id: "credential_row_too_large",
                remediation: "restart_with_supported_harness",
            },
            {
                id: "credential_snapshot_mismatch",
                remediation: "restart_with_supported_harness",
            },
        ],
        value_cap_bytes: 16384,
        row_cap_bytes: 65536,
    },
    // Credential-row fingerprints use the configured domain separator.
    // ever emitted.
    credential_fingerprint: {
        domain: "subc-broca-credential-v1",
        canonicalization: "harness-provider-name-length-value/1",
    },
    // Only the listed physical install layouts are supported.
    install_layouts: [
        "bun_physical_link",
        "compiled_bun_external",
        "npm_hoisted",
        "npm_nested",
    ],
} as const;

export type ReleaseContract = typeof CONTRACT;

export function buildContract(): ReleaseContract {
    return CONTRACT;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

/* */
type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [key: string]: JsonValue };

/* */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(sortKeys(value as JsonValue), null, 2);
}

function sortKeys(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value !== null && typeof value === "object") {
        const out: { [key: string]: JsonValue } = {};
        // Default string sorting is locale-independent.
        for (const key of Object.keys(value).sort()) {
            out[key] = sortKeys(value[key]);
        }
        return out;
    }
    return value;
}

export function sha256Hex(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
/**
 * An exact SemVer prerelease reserves an inert name.
 * Ranges without a prerelease on the same version triple exclude prerelease versions.
 * `^` and `~` ranges without a prerelease on the same version triple cannot select the reservation.
 * Bare `reserved` labels and GA versions do not satisfy the reservation gate.
 */
// The reservation must be an npm-publishable SemVer prerelease.
// Numeric prerelease identifiers cannot contain leading zeroes.
// version identity.
const RESERVATION_VERSION_RE =
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*$/;
const DOTTED_FLOOR_RE = /^\d+\.\d+$/;

function fail(message: string): never {
    throw new Error(`mc-host release contract: ${message}`);
}

/**
 *
 */
export function exactKeysAsserter(
    subject: string,
): (
    obj: unknown,
    keys: string[],
    where: string,
    optional?: string[],
) => void {
    const reject = (message: string): never => {
        throw new Error(`${subject}: ${message}`);
    };
    return (obj, keys, where, optional = []): void => {
        if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
            reject(`${where} must be an object`);
        }
        // SAFETY: The guard excludes `null` and arrays before casting `obj` to `Record<string, unknown>`.
        const record = obj as Record<string, unknown>;
        for (const key of Object.keys(record)) {
            if (!keys.includes(key) && !optional.includes(key)) {
                reject(`${where}: unknown key ${key}`);
            }
        }
        for (const key of keys) {
            if (!(key in record)) reject(`${where}: missing key ${key}`);
        }
    };
}

const assertExactKeys = exactKeysAsserter("mc-host release contract");

function compareSemver(a: string, b: string): number {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
    }
    return 0;
}

/**
 */
function rejectHashes(value: unknown, path: string): void {
    if (typeof value === "string") {
        if (
            /^[0-9a-fA-F]{64}$/.test(value) ||
            /^(sha\d+|blake\d*):/i.test(value)
        ) {
            fail(`hash-like value forbidden in pre-build contract at ${path}`);
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => rejectHashes(item, `${path}[${index}]`));
        return;
    }
    if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(
            value as Record<string, unknown>,
        )) {
            if (/(^|_)(hash|digest|sha\d*)($|_)/i.test(key)) {
                fail(
                    `hash-bearing key forbidden in pre-build contract at ${path}.${key}`,
                );
            }
            rejectHashes(child, `${path}.${key}`);
        }
    }
}

function assertUniqueSorted(values: readonly string[], where: string): void {
    for (let i = 1; i < values.length; i++) {
        if (values[i - 1] >= values[i]) {
            fail(
                `${where} must be strictly sorted and unique; violation near "${values[i]}"`,
            );
        }
    }
}

function assertUnique(values: readonly string[], where: string): void {
    if (new Set(values).size !== values.length) fail(`${where} must be unique`);
}

function assertHalfOpenRange(
    range: { min_inclusive: string; max_exclusive: string },
    where: string,
): void {
    if (
        !SEMVER_RE.test(range.min_inclusive) ||
        !SEMVER_RE.test(range.max_exclusive)
    ) {
        fail(`${where} bounds must be exact semver`);
    }
    if (compareSemver(range.min_inclusive, range.max_exclusive) >= 0) {
        fail(`${where} must be a non-empty half-open range`);
    }
}

export function validateContractSchema(contract: any): void {
    if (contract === null || typeof contract !== "object")
        fail("contract must be an object");
    assertExactKeys(
        contract,
        [
            "cli",
            "coordination",
            "credential_fingerprint",
            "epochs",
            "harness_unavailable",
            "install_layouts",
            "layout",
            "model_lane",
            "packages",
            "platforms",
            "proof",
            "release",
            "schema",
            "stop_provenance_schema",
            "versions",
        ],
        "contract",
    );
    if (contract.schema !== "magic-context.mc-host-release/v1")
        fail("unknown contract schema");

    // Release identity.
    assertExactKeys(contract.release, ["id", "version"], "release");
    if (contract.release.id !== "mc-host-release") fail("release.id is fixed");
    if (!SEMVER_RE.test(contract.release.version))
        fail("release.version must be exact semver");

    // Packages require three parents, three payloads, and one synchronized version.
    assertExactKeys(
        contract.packages,
        ["addons", "parents", "payloads", "version"],
        "packages",
    );
    if (contract.packages.version !== contract.release.version) {
        fail("packages.version must equal release.version");
    }
    if (
        contract.packages.parents.length !== 3 ||
        contract.packages.payloads.length !== 3 ||
        contract.packages.addons.length !== 1
    ) {
        fail(
            "exactly three parent, three payload, and one addon package are required",
        );
    }
    assertUnique(
        [
            ...contract.packages.parents,
            ...contract.packages.payloads,
            ...contract.packages.addons,
        ],
        "package names",
    );

    assertExactKeys(
        contract.versions,
        ["daemon", "modules", "supported_daemon_range", "wire_protocol"],
        "versions",
    );
    if (!/^mc-host\/\d+\.\d+\.\d+$/.test(contract.versions.daemon)) {
        fail("versions.daemon must be mc-host/<semver>");
    }
    if (contract.versions.wire_protocol !== 2)
        fail("wire_protocol is fixed at 2 for this contract");
    assertHalfOpenRange(
        contract.versions.supported_daemon_range,
        "supported_daemon_range",
    );
    const daemonSemver = contract.versions.daemon.slice("mc-host/".length);
    if (
        compareSemver(
            daemonSemver,
            contract.versions.supported_daemon_range.min_inclusive,
        ) < 0 ||
        compareSemver(
            daemonSemver,
            contract.versions.supported_daemon_range.max_exclusive,
        ) >= 0
    ) {
        fail("versions.daemon must fall inside supported_daemon_range");
    }
    assertExactKeys(
        contract.versions.modules,
        ["broca", "magic_context", "synapse"],
        "versions.modules",
    );
    for (const [name, module] of Object.entries(contract.versions.modules) as [
        string,
        {
            version: string;
            range: { min_inclusive: string; max_exclusive: string };
        },
    ][]) {
        assertExactKeys(
            module as unknown as Record<string, unknown>,
            ["range", "version"],
            `modules.${name}`,
        );
        if (!SEMVER_RE.test(module.version))
            fail(`modules.${name}.version must be exact semver`);
        assertHalfOpenRange(module.range, `modules.${name}.range`);
        if (
            compareSemver(module.version, module.range.min_inclusive) < 0 ||
            compareSemver(module.version, module.range.max_exclusive) >= 0
        ) {
            fail(`modules.${name}.version must fall inside its range`);
        }
    }

    assertExactKeys(
        contract.proof,
        [
            "current_offers",
            "current_version",
            "legacy_stop_only",
            "transcript_fields",
        ],
        "proof",
    );
    if (
        !Number.isInteger(contract.proof.current_version) ||
        contract.proof.current_version < 1
    ) {
        fail("proof.current_version must be a positive integer");
    }
    if (
        !Array.isArray(contract.proof.current_offers) ||
        contract.proof.current_offers.length === 0 ||
        !contract.proof.current_offers.every((v: any) => Number.isInteger(v)) ||
        !contract.proof.current_offers.includes(contract.proof.current_version)
    ) {
        fail(
            "proof.current_offers must be a non-empty ordered integer list containing current_version",
        );
    }
    const expectedTranscript = [
        "offers",
        "selected_version",
        "daemon_ver",
        "client_nonce",
        "server_nonce",
        "daemon_id",
    ];
    if (
        JSON.stringify(contract.proof.transcript_fields) !==
        JSON.stringify(expectedTranscript)
    ) {
        fail("proof.transcript_fields must bind exactly the KTD20 field order");
    }
    const legacy = contract.proof.legacy_stop_only;
    assertExactKeys(
        legacy,
        [
            "adjacent_release_only",
            "missing_offer_inference",
            "scope",
            "version",
        ],
        "proof.legacy_stop_only",
    );
    if (legacy.version !== contract.proof.current_version - 1) {
        fail("legacy stop-only proof must be exactly N-1");
    }
    if (
        legacy.scope !== "stop_only" ||
        legacy.adjacent_release_only !== true ||
        legacy.missing_offer_inference !== false
    ) {
        fail(
            "legacy proof profile must be stop-only, adjacent-only, with no missing-offer inference",
        );
    }
    if (contract.proof.current_offers.includes(legacy.version)) {
        fail(
            "legacy proof version must never appear in the current offer list",
        );
    }

    const stop = contract.stop_provenance_schema;
    assertExactKeys(
        stop,
        ["genesis", "predecessor", "tag_field", "tags"],
        "stop_provenance_schema",
    );
    if (
        stop.tag_field !== "tag" ||
        JSON.stringify(stop.tags) !== JSON.stringify(["genesis", "predecessor"])
    ) {
        fail("stop-provenance tags must be exactly genesis | predecessor");
    }
    if (stop.genesis.legacy_stop_authority !== false)
        fail("genesis must carry no legacy stop authority");
    if (stop.predecessor.legacy_stop_authority !== true)
        fail("predecessor carries the only legacy stop authority");
    for (const field of stop.genesis.forbidden_fields) {
        if (stop.genesis.required_fields.includes(field)) {
            fail(
                `genesis field ${field} cannot be both required and forbidden`,
            );
        }
        if (!stop.predecessor.required_fields.includes(field)) {
            fail(
                `genesis-forbidden field ${field} must be a predecessor-required field`,
            );
        }
    }

    assertExactKeys(
        contract.epochs,
        [
            "compartment_render",
            "memory_render",
            "profile_claude_code_anthropic",
            "state_sync",
            "tagger",
        ],
        "epochs",
    );
    for (const [name, epoch] of Object.entries(contract.epochs)) {
        if (!Number.isInteger(epoch) || (epoch as number) < 0)
            fail(`epoch ${name} must be a non-negative integer`);
    }
    if (contract.epochs.state_sync < 1)
        fail("state_sync epoch must be a positive integer");

    assertExactKeys(
        contract.platforms,
        ["supported", "unsupported_reason"],
        "platforms",
    );
    if (contract.platforms.unsupported_reason !== "unsupported_platform") {
        fail("platforms.unsupported_reason is fixed");
    }
    const targets = contract.platforms.supported.map(
        (p: { target: string }) => p.target,
    );
    if (
        JSON.stringify([...targets].sort()) !==
        JSON.stringify(["darwin-arm64", "darwin-x64", "linux-x64-gnu"])
    ) {
        fail(
            "supported platform targets are fixed to linux-x64-gnu, darwin-arm64, darwin-x64",
        );
    }
    for (const platform of contract.platforms.supported) {
        if (platform.target === "linux-x64-gnu") {
            if (
                !DOTTED_FLOOR_RE.test(platform.kernel_min) ||
                !DOTTED_FLOOR_RE.test(platform.glibc_min)
            ) {
                fail("linux floors must be exact dotted versions");
            }
            if (platform.capabilities.procfs_self_fd_exec !== true) {
                fail("linux requires qualified procfs self-fd execution");
            }
            if (platform.synapse !== "certified_cpu")
                fail("linux synapse lane must be certified_cpu");
        } else {
            if (!DOTTED_FLOOR_RE.test(platform.os_min))
                fail(`${platform.target} os floor must be exact`);
            if (
                platform.synapse !== "unsupported" ||
                platform.synapse_reason !== "synapse_unsupported"
            ) {
                fail(
                    `${platform.target} synapse must be exactly unsupported / synapse_unsupported`,
                );
            }
            if (platform.capabilities.dev_fd_exec !== true) {
                fail(
                    `${platform.target} requires /dev/fd execution capability`,
                );
            }
        }
        assertUniqueSorted(
            platform.capabilities.filesystem,
            `${platform.target} filesystem capabilities`,
        );
    }

    assertExactKeys(
        contract.model_lane,
        ["execution_provider", "id", "platforms", "unsupported"],
        "model_lane",
    );
    if (
        contract.model_lane.id !== "gte-modernbert-base-f16" ||
        contract.model_lane.execution_provider !== "cpu"
    ) {
        fail("model lane is fixed to the CPU gte-modernbert-base-f16 lane");
    }
    if (
        JSON.stringify(contract.model_lane.platforms) !==
        JSON.stringify(["linux-x64-gnu"])
    ) {
        fail("model lane platforms are fixed to linux-x64-gnu");
    }

    assertExactKeys(
        contract.coordination,
        ["directory", "lifetime_lock", "transaction_lock"],
        "coordination",
    );
    if (
        contract.coordination.directory !== ".mc-host-coordination" ||
        contract.coordination.transaction_lock !== "transaction.lock" ||
        contract.coordination.lifetime_lock !== "lifetime.lock"
    ) {
        fail("coordination names are fixed and version-neutral");
    }

    // Managed data-root layout segments.
    assertExactKeys(
        contract.layout,
        [
            "connection_file",
            "managed_subtree",
            "runtime_directory",
            "storage_subdirectory",
        ],
        "layout",
    );
    if (
        contract.layout.managed_subtree !== "cortexkit" ||
        contract.layout.runtime_directory !== "run" ||
        contract.layout.connection_file !== "subc-connection.json" ||
        contract.layout.storage_subdirectory !== "magic-context"
    ) {
        fail("managed layout segments are fixed and version-neutral");
    }

    // Closed CLI unions (KTD12).
    const cli = contract.cli;
    assertExactKeys(
        cli,
        [
            "check_ids",
            "check_statuses",
            "commands",
            "effects",
            "exit_codes",
            "readiness_states",
            "reasons",
            "remediations",
            "result_schema",
            "states",
        ],
        "cli",
    );
    if (cli.result_schema !== "magic-context.daemon/v1")
        fail("cli.result_schema is fixed");
    if (
        JSON.stringify(cli.commands) !==
        JSON.stringify(["start", "stop", "restart", "status", "doctor"])
    ) {
        fail("cli.commands is a fixed closed union");
    }
    if (
        JSON.stringify(cli.states) !==
        JSON.stringify([
            "unavailable",
            "stopped",
            "starting",
            "running",
            "stopping",
            "wedged",
        ])
    ) {
        fail("cli.states is a fixed closed union");
    }
    if (
        JSON.stringify(cli.check_statuses) !==
        JSON.stringify(["pass", "fail", "warn", "skip"])
    ) {
        fail("cli.check_statuses is fixed");
    }
    if (cli.check_ids.length !== 22)
        fail("the closed v1 check-ID union has exactly 22 entries");
    assertUniqueSorted(cli.check_ids, "cli.check_ids");
    if (cli.remediations.length !== 15)
        fail("the closed remediation union has exactly 15 entries");
    assertUniqueSorted(cli.remediations, "cli.remediations");
    if (cli.reasons.failing_by_precedence.length !== 31) {
        fail("the failing reason precedence table has exactly 31 rows");
    }
    assertUnique(
        cli.reasons.failing_by_precedence.map((row: { id: string }) => row.id),
        "failing reason ids",
    );
    for (const row of cli.reasons.failing_by_precedence) {
        if (
            row.remediation !== null &&
            !cli.remediations.includes(row.remediation)
        ) {
            fail(`reason ${row.id} names an unknown remediation`);
        }
        if (row.id === "harness_unavailable") {
            if (
                row.remediation !== null ||
                row.remediation_from_subreason !== true
            ) {
                fail(
                    "harness_unavailable remediation is decided per subreason",
                );
            }
        }
    }
    assertUniqueSorted(cli.reasons.non_failing, "cli.reasons.non_failing");
    if (!cli.reasons.non_failing.includes("synapse_unsupported")) {
        fail("synapse_unsupported is a non-failing component reason");
    }
    if (
        JSON.stringify(cli.readiness_states.shared_memory) !==
        JSON.stringify(["ready", "starting", "unavailable"])
    ) {
        fail("shared-memory readiness states are fixed");
    }
    if (
        JSON.stringify(cli.readiness_states.storage) !==
        JSON.stringify(["ready", "starting", "unavailable"])
    ) {
        fail("storage readiness states are fixed");
    }
    if (
        JSON.stringify(cli.readiness_states.synapse) !==
        JSON.stringify(["ready", "starting", "degraded", "unsupported"])
    ) {
        fail("synapse readiness states are fixed");
    }
    if (
        JSON.stringify(cli.effects) !==
        JSON.stringify({
            restart_only: true,
            fields: ["stop_committed", "start_committed"],
        })
    ) {
        fail("restart effects shape is fixed");
    }
    if (
        JSON.stringify(cli.exit_codes) !==
        JSON.stringify({ ok: 0, operational_failure: 1, usage: 2 })
    ) {
        fail("cli exit codes are fixed");
    }

    // `harness_unavailable_reason` accepts only declared values in precedence order.
    const harness = contract.harness_unavailable;
    assertExactKeys(
        harness,
        ["reasons_by_precedence", "row_cap_bytes", "value_cap_bytes"],
        "harness_unavailable",
    );
    const expectedHarnessOrder = [
        "descriptor_absent",
        "descriptor_invalid",
        "closure_incomplete",
        "argument_variant_invalid",
        "provider_unsupported",
        "auth_mechanism_unsupported",
        "credential_missing",
        "credential_value_too_large",
        "credential_row_too_large",
        "credential_snapshot_mismatch",
    ];
    if (
        JSON.stringify(
            harness.reasons_by_precedence.map((row: { id: string }) => row.id),
        ) !== JSON.stringify(expectedHarnessOrder)
    ) {
        fail("harness_unavailable_reason union/order is fixed");
    }
    for (const row of harness.reasons_by_precedence) {
        const expectNull =
            row.id === "provider_unsupported" ||
            row.id === "auth_mechanism_unsupported";
        if (
            expectNull
                ? row.remediation !== null
                : row.remediation !== "restart_with_supported_harness"
        ) {
            fail(`harness subreason ${row.id} has the wrong remediation`);
        }
    }
    if (harness.value_cap_bytes !== 16384 || harness.row_cap_bytes !== 65536) {
        fail("credential value/row caps are fixed at 16 KiB / 64 KiB");
    }

    assertExactKeys(
        contract.credential_fingerprint,
        ["canonicalization", "domain"],
        "credential_fingerprint",
    );
    if (
        contract.credential_fingerprint.domain !== "subc-broca-credential-v1" ||
        contract.credential_fingerprint.canonicalization !==
            "harness-provider-name-length-value/1"
    ) {
        fail(
            "credential fingerprint domain/canonicalization identifiers are fixed",
        );
    }

    if (
        JSON.stringify(contract.install_layouts) !==
        JSON.stringify([
            "bun_physical_link",
            "compiled_bun_external",
            "npm_hoisted",
            "npm_nested",
        ])
    ) {
        fail("install layout identifiers are fixed");
    }

    // The validator rejects hash-like key names and 64-character hexadecimal or prefixed SHA/BLAKE values at every traversed path.
    rejectHashes(contract, "$");
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export interface RegistryGatePackage {
    name: string;
    kind: "parent" | "payload";
    ownership_verified: boolean;
    trusted_publisher_configured: boolean;
    synchronized_version_unpublished: boolean;
    reservation_version?: string | null;
    bootstrap_credential_revoked?: boolean;
}

export interface RegistryGate {
    schema: string;
    note?: string;
    release_version: string;
    packages: RegistryGatePackage[];
}

function gateFail(message: string): never {
    throw new Error(`mc-host registry gate: ${message}`);
}

/**
 * The validator checks the gate's structure but does not assert that audited conditions are met.
 *
 */
export function validateRegistryGateShape(
    gate: unknown,
    contract: ReleaseContract,
): RegistryGate {
    if (gate === null || typeof gate !== "object")
        gateFail("gate must be an object");
    const g = gate as RegistryGate;
    if (g.schema !== "magic-context.mc-host-registry-gate/v1")
        gateFail("unknown gate schema");
    if (g.release_version !== contract.release.version) {
        gateFail(
            `gate release_version ${g.release_version} does not match contract ${contract.release.version}`,
        );
    }
    if (!Array.isArray(g.packages)) gateFail("gate packages must be an array");
    const expected = new Map<string, "parent" | "payload" | "addon">();
    for (const name of contract.packages.parents) expected.set(name, "parent");
    for (const name of contract.packages.payloads)
        expected.set(name, "payload");
    for (const name of contract.packages.addons) expected.set(name, "addon");
    const seen = new Set<string>();
    for (const pkg of g.packages) {
        const kind = expected.get(pkg.name);
        if (kind === undefined) gateFail(`unexpected package ${pkg.name}`);
        if (seen.has(pkg.name)) gateFail(`duplicate package ${pkg.name}`);
        seen.add(pkg.name);
        if (pkg.kind !== kind)
            gateFail(`package ${pkg.name} must have kind ${kind}`);
        for (const field of [
            "ownership_verified",
            "trusted_publisher_configured",
            "synchronized_version_unpublished",
        ] as const) {
            if (typeof pkg[field] !== "boolean") {
                gateFail(`${field} for ${pkg.name} must be boolean`);
            }
        }
        if (kind === "payload") {
            if (typeof pkg.bootstrap_credential_revoked !== "boolean") {
                gateFail(
                    `bootstrap_credential_revoked for ${pkg.name} must be boolean`,
                );
            }
            // An unreserved name is recorded as `null`, which readiness rejects.
            // A non-null `reservation_version` must be an inert prerelease.
            // `reservation_version` presence does not establish inertness.
            // A GA version is selectable by an ordinary dependent range.
            // `release.version` is GA semver, so a prerelease cannot equal it.
            const reservation = pkg.reservation_version;
            if (reservation !== null && reservation !== undefined) {
                if (
                    typeof reservation !== "string" ||
                    !RESERVATION_VERSION_RE.test(reservation)
                ) {
                    gateFail(
                        `reservation version ${String(reservation)} for ${pkg.name} must be an inert prerelease (MAJOR.MINOR.PATCH-<prerelease>)`,
                    );
                }
            }
        }
    }
    if (seen.size !== expected.size) {
        const missing = [...expected.keys()].filter((name) => !seen.has(name));
        gateFail(`missing package entries: ${missing.join(", ")}`);
    }
    return g;
}

/**
 *
 * Drift checks must not evaluate audited values because fail-closed gates are expected outside release windows.
 * `validateRegistryGateShape` must run before the readiness check.
 */
export function assertRegistryGateReleaseReady(gate: RegistryGate): void {
    for (const pkg of gate.packages) {
        if (pkg.ownership_verified !== true)
            gateFail(`ownership not verified for ${pkg.name}`);
        if (pkg.trusted_publisher_configured !== true) {
            gateFail(`trusted publisher not configured for ${pkg.name}`);
        }
        if (pkg.synchronized_version_unpublished !== true) {
            gateFail(
                `synchronized version ${gate.release_version} is not unpublished for ${pkg.name}`,
            );
        }
        if (pkg.kind === "payload") {
            if (pkg.bootstrap_credential_revoked !== true) {
                gateFail(`bootstrap credential not revoked for ${pkg.name}`);
            }
            if (
                typeof pkg.reservation_version !== "string" ||
                pkg.reservation_version.length === 0
            ) {
                gateFail(`missing inert reservation version for ${pkg.name}`);
            }
        }
    }
}

/** Publication requires both shape validation and release readiness. */
export function validateRegistryGate(
    gate: unknown,
    contract: ReleaseContract,
): void {
    assertRegistryGateReleaseReady(validateRegistryGateShape(gate, contract));
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export interface PlatformProbe {
    os: string;
    arch: string;
    libc?: "gnu" | "musl";
    kernel?: string;
    glibc?: string;
    osVersion?: string;
    procfsSelfFdExec?: boolean;
    devFdExec?: boolean;
}

/**
 * Host version strings can contain suffixes.
 * `uname -r` can report versions such as `4.18.0-513.el8.x86_64`, whose suffix must not affect floor comparison.
 * On RHEL 8, glibc reports `2.28-236.el8`.
 * Each `probe` component contributes its leading integer; one without leading digits counts as 0.
 * A nonnumeric floor component yields `NaN`, which the caller rejects.
 *
 */
export function compareDotted(probe: string, floor: string): number {
    const floorParts = floor.split(".").map(Number);
    const probeParts = probe.split(".").map((part) => {
        const digits = /^\d+/.exec(part);
        return digits === null ? 0 : Number(digits[0]);
    });
    for (let i = 0; i < floorParts.length; i++) {
        const df = floorParts[i] ?? 0;
        if (Number.isNaN(df)) return Number.NaN;
        const dp = probeParts[i] ?? 0;
        if (dp !== df) return dp - df;
    }
    return 0;
}

/**
 *
 * The caller must validate `probe`: `compareDotted` treats missing or nonnumeric `probe` components as 0.
 *
 * `compareDotted` ranks `999garbage` above `4.18`.
 * `compareDotted` treats `4.18-rc1` as equal to `4.18`.
 *
 * Once a component exceeds the floor, later prerelease suffixes do not affect acceptance: `4.18.0-rc2` is rejected, but `4.18.1-rc2` is accepted.
 *
 */
export function meetsDottedFloor(probe: unknown, floor: string): boolean {
    if (typeof probe !== "string" || probe.length === 0) return false;
    const parts = probe.split(".");
    const floorParts = floor.split(".");
    if (parts.length < floorParts.length) return false;
    // `compareDotted` discards suffix text, so `999garbage` scores as 999.
    for (let i = 0; i < floorParts.length; i++) {
        // `.+` rejects dangling separators such as `4.18-` and `2.28+`.
        // separator entirely.
        if (!/^\d+(?:[-+._~].+)?$/.test(parts[i] ?? "")) return false;
    }
    const ordering = compareDotted(probe, floor);
    if (Number.isNaN(ordering) || ordering < 0) return false;
    if (ordering !== 0) return true;
    for (const [index, part] of parts.entries()) {
        if (index >= floorParts.length) {
            const leading = /^\d*/.exec(part)?.[0] ?? "";
            if (Number(leading || "0") > 0) break;
        }
        // The prerelease check recognizes every separator that the shape check admits.
        // The prerelease check treats `~` and `_` as prerelease markers.
        if (/^\d*[-+._~]?(?:rc|pre|alpha|beta|dev|snapshot)/i.test(part)) {
            return false;
        }
    }
    return true;
}

/* */
export function evaluatePlatform(
    contract: ReleaseContract,
    probe: PlatformProbe,
): {
    supported: boolean;
    reason?: string;
    target?: string;
    synapse?: string;
    synapseReason?: string;
} {
    const unsupported = {
        supported: false,
        reason: contract.platforms.unsupported_reason,
    };
    if (probe.os === "linux") {
        if (probe.arch !== "x64" || probe.libc !== "gnu") return unsupported;
        const linux = contract.platforms.supported.find(
            (p) => p.target === "linux-x64-gnu",
        );
        if (linux === undefined || !("kernel_min" in linux)) return unsupported;
        if (!meetsDottedFloor(probe.kernel, linux.kernel_min)) {
            return unsupported;
        }
        if (!meetsDottedFloor(probe.glibc, linux.glibc_min)) {
            return unsupported;
        }
        if (probe.procfsSelfFdExec !== true) return unsupported;
        return {
            supported: true,
            target: linux.target,
            synapse: linux.synapse,
        };
    }
    if (probe.os === "darwin") {
        const target =
            probe.arch === "arm64"
                ? "darwin-arm64"
                : probe.arch === "x64"
                  ? "darwin-x64"
                  : undefined;
        if (target === undefined) return unsupported;
        const mac = contract.platforms.supported.find(
            (p) => p.target === target,
        );
        if (mac === undefined || !("os_min" in mac)) return unsupported;
        if (!meetsDottedFloor(probe.osVersion, mac.os_min)) {
            return unsupported;
        }
        if (
            "capabilities" in mac &&
            "dev_fd_exec" in mac.capabilities &&
            mac.capabilities.dev_fd_exec === true &&
            probe.devFdExec !== true
        ) {
            return unsupported;
        }
        return {
            supported: true,
            target,
            synapse: mac.synapse,
            synapseReason: mac.synapse_reason,
        };
    }
    return unsupported;
}

/**
 */
export function evaluateProofOffers(
    contract: ReleaseContract,
    offers: unknown,
): { accepted: boolean; selected?: number } {
    if (!Array.isArray(offers) || offers.length === 0)
        return { accepted: false };
    if (
        !offers.every(
            (offer) => Number.isInteger(offer) && (offer as number) >= 1,
        )
    ) {
        return { accepted: false };
    }
    if (!offers.includes(contract.proof.current_version))
        return { accepted: false };
    return { accepted: true, selected: contract.proof.current_version };
}

/**
 */
export function validateStopProvenance(
    contract: ReleaseContract,
    record: unknown,
): { valid: boolean; legacyStopAuthority: boolean; error?: string } {
    const invalid = (error: string) => ({
        valid: false,
        legacyStopAuthority: false,
        error,
    });
    if (
        record === null ||
        typeof record !== "object" ||
        Array.isArray(record)
    ) {
        return invalid("record must be an object");
    }
    const rec = record as Record<string, unknown>;
    const schema = contract.stop_provenance_schema;
    const tag = rec[schema.tag_field];
    if (tag !== "genesis" && tag !== "predecessor")
        return invalid("unknown stop-provenance tag");
    if (tag === "genesis") {
        for (const field of schema.genesis.forbidden_fields) {
            if (field in rec)
                return invalid(
                    `genesis carries no legacy authority; forbidden field ${field}`,
                );
        }
        const keys = Object.keys(rec).sort();
        if (
            JSON.stringify(keys) !==
            JSON.stringify([...schema.genesis.required_fields].sort())
        ) {
            return invalid("genesis must carry exactly its required fields");
        }
        if (rec.release_version !== contract.release.version) {
            return invalid("genesis must bind the current release identity");
        }
        return { valid: true, legacyStopAuthority: false };
    }
    for (const field of schema.predecessor.required_fields) {
        const value = rec[field];
        if (value === undefined || value === null || value === "") {
            return invalid(
                `predecessor record missing required field ${field}`,
            );
        }
    }
    const keys = Object.keys(rec).sort();
    if (
        JSON.stringify(keys) !==
        JSON.stringify([...schema.predecessor.required_fields].sort())
    ) {
        return invalid(
            "predecessor record must carry exactly its required fields",
        );
    }
    // contract.
    if (rec.release_version !== contract.release.version) {
        return invalid("predecessor must bind the current release identity");
    }
    const nonEmptyString = (field: string): string | null => {
        const value = rec[field];
        return typeof value === "string" && value.length > 0 ? value : null;
    };
    if (rec.legacy_proof_version !== contract.proof.legacy_stop_only.version) {
        return invalid(
            "predecessor must carry the contract's legacy stop-only proof version",
        );
    }
    const target = nonEmptyString("target");
    if (target === null) {
        return invalid("predecessor target must be a nonempty string");
    }
    if (!contract.platforms.supported.some((row) => row.target === target)) {
        return invalid(`predecessor target ${target} is not a supported platform`);
    }
    if (nonEmptyString("payload_manifest_digest") === null) {
        return invalid(
            "predecessor payload_manifest_digest must be a nonempty string",
        );
    }
    const predecessorRelease = nonEmptyString("predecessor_release_version");
    if (predecessorRelease === null || !SEMVER_RE.test(predecessorRelease)) {
        return invalid("predecessor_release_version must be exact semver");
    }
    if (compareSemver(predecessorRelease, contract.release.version) >= 0) {
        return invalid(
            "predecessor_release_version must be older than the current release",
        );
    }
    const predecessorDaemon = nonEmptyString("predecessor_daemon_version");
    if (
        predecessorDaemon === null ||
        !/^mc-host\/\d+\.\d+\.\d+$/.test(predecessorDaemon)
    ) {
        return invalid("predecessor_daemon_version must be mc-host/<semver>");
    }
    const manifest = rec.predecessor_manifest;
    if (
        manifest === null ||
        typeof manifest !== "object" ||
        Array.isArray(manifest)
    ) {
        return invalid("predecessor_manifest must be an object");
    }
    return { valid: true, legacyStopAuthority: true };
}

// ---------------------------------------------------------------------------
// Output rendering.
// ---------------------------------------------------------------------------

const GENERATED_BANNER =
    "@generated by scripts/generate-mc-host-release-manifest.ts. Do not edit.\n" +
    "Regenerate: bun scripts/generate-mc-host-release-manifest.ts\n" +
    "Drift check: bun scripts/generate-mc-host-release-manifest.ts --check";

function escapeRustString(text: string): string {
    return text
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n");
}

export function renderRustOutput(canonical: string, digest: string): string {
    const contract = buildContract();
    const banner = GENERATED_BANNER.split("\n")
        .map((line) => `// ${line}`)
        .join("\n");
    return `${banner}
//

pub const RELEASE_CONTRACT_JSON: &str = "${escapeRustString(canonical)}";

pub const RELEASE_CONTRACT_SHA256: &str = "${digest}";

pub const RELEASE_VERSION: &str = "${contract.release.version}";

pub const DAEMON_VERSION: &str = "${contract.versions.daemon}";

pub const WIRE_PROTOCOL_VERSION: u8 = ${contract.versions.wire_protocol};

pub const MEMORY_RENDER_EPOCH: u32 = ${contract.epochs.memory_render};
pub const COMPARTMENT_RENDER_EPOCH: u32 = ${contract.epochs.compartment_render};
pub const PROFILE_EPOCH_CLAUDE_CODE_ANTHROPIC: u32 = ${contract.epochs.profile_claude_code_anthropic};
pub const TAGGER_EPOCH: u32 = ${contract.epochs.tagger};
pub const STATE_SYNC_EPOCH: u32 = ${contract.epochs.state_sync};

pub const COORDINATION_DIRECTORY: &str = "${contract.coordination.directory}";
pub const TRANSACTION_LOCK_NAME: &str = "${contract.coordination.transaction_lock}";
pub const LIFETIME_LOCK_NAME: &str = "${contract.coordination.lifetime_lock}";

/// Managed data-root layout segments (\`\${dataRoot}/cortexkit/...\`).
pub const MANAGED_SUBTREE_DIRECTORY: &str = "${contract.layout.managed_subtree}";
pub const RUNTIME_DIRECTORY_NAME: &str = "${contract.layout.runtime_directory}";
pub const CONNECTION_FILE_NAME: &str = "${contract.layout.connection_file}";
pub const STORAGE_SUBDIRECTORY: &str = "${contract.layout.storage_subdirectory}";
`;
}

export function renderRetinaLayoutTsOutput(
    contract: ReturnType<typeof buildContract>,
): string {
    const banner = GENERATED_BANNER.split("\n")
        .map((line) => ` * ${line}`)
        .join("\n");
    return `/**
${banner}
 *
 * Managed data-root layout segments from the release contract.
 * \`retina-local-fs\` is a dependency of the plugin packages, so it cannot
 * import their generated contract module; this standalone copy is emitted
 * and drift-checked by the same generator instead.
 */

export const managedLayout = {
    managedSubtree: ${JSON.stringify(contract.layout.managed_subtree)},
    runtimeDirectory: ${JSON.stringify(contract.layout.runtime_directory)},
    connectionFile: ${JSON.stringify(contract.layout.connection_file)},
    storageSubdirectory: ${JSON.stringify(contract.layout.storage_subdirectory)},
} as const;
`;
}

export function renderTsOutput(canonical: string, digest: string): string {
    const banner = GENERATED_BANNER.split("\n")
        .map((line) => ` * ${line}`)
        .join("\n");
    return `/**
${banner}
 *
 * Pre-build release and compatibility contract (U8, KTD7).
 */

/**
 */
export const RELEASE_CONTRACT_JSON: string = ${JSON.stringify(canonical)};

/* */
export const RELEASE_CONTRACT_SHA256 = "${digest}";

/* */
export const releaseContract = ${canonical} as const;
`;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export const OUTPUT_PATHS = {
    contractJson: "release/mc-host-release.json",
    rust: "release/generated/mc-host-release-contract.rs",
    typescript:
        "packages/plugin/src/shared/mc-host-lifecycle/generated-contract.ts",
    retinaLayout: "packages/retina-local-fs/src/generated-layout.ts",
} as const;

export const REGISTRY_GATE_PATH = "release/mc-host-registry-gate.json";

export interface GenerateResult {
    digest: string;
    drift: string[];
    outputs: Record<keyof typeof OUTPUT_PATHS, string>;
}

export function generate(
    rootDir: string,
    options: { check: boolean },
): GenerateResult {
    const contract = buildContract();
    validateContractSchema(contract);

    const gatePath = join(rootDir, REGISTRY_GATE_PATH);
    if (!existsSync(gatePath)) {
        throw new Error(
            `mc-host registry gate: missing ${REGISTRY_GATE_PATH}; release engineering must ` +
                "populate it after the real npm ownership/reservation/trusted-publisher checks (R50)",
        );
    }
    let gate: unknown;
    try {
        gate = JSON.parse(readFileSync(gatePath, "utf8"));
    } catch (error) {
        throw new Error(
            `mc-host registry gate: unreadable or malformed ${REGISTRY_GATE_PATH}: ` +
                (error instanceof Error ? error.message : String(error)),
        );
    }
    validateRegistryGateShape(gate, contract);

    const canonical = canonicalJson(contract);
    const digest = sha256Hex(canonical);
    const outputs = {
        contractJson: `${canonical}\n`,
        rust: renderRustOutput(canonical, digest),
        typescript: renderTsOutput(canonical, digest),
        retinaLayout: renderRetinaLayoutTsOutput(contract),
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
                    `${relative}: content drift (regenerate with bun scripts/generate-mc-host-release-manifest.ts)`,
                );
            }
        } else {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, expected);
        }
    }
    return { digest, drift, outputs };
}

function main(): void {
    const args = process.argv.slice(2);
    const check = args.includes("--check");
    const unknown = args.filter((arg) => arg !== "--check");
    if (unknown.length > 0) {
        console.error(`unknown arguments: ${unknown.join(" ")}`);
        process.exit(2);
    }
    const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    let result: GenerateResult;
    try {
        result = generate(rootDir, { check });
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
    if (check && result.drift.length > 0) {
        console.error("mc-host release contract drift:");
        for (const line of result.drift) console.error(`  - ${line}`);
        process.exit(1);
    }
    console.log(
        `${check ? "checked" : "generated"} mc-host release contract ` +
            `(release ${buildContract().release.version}, sha256 ${result.digest})`,
    );
}

if (import.meta.main) main();
