// ../plugin/src/shared/harness.ts
var currentHarness = "opencode";
var harnessLocked = false;
function setHarness(value) {
  if (harnessLocked && currentHarness !== value) {
    throw new Error(`Magic Context: harness already locked to "${currentHarness}"; cannot change to "${value}"`);
  }
  currentHarness = value;
  harnessLocked = true;
}
function getHarness() {
  return currentHarness;
}

// ../plugin/src/shared/data-path.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ../plugin/src/shared/mc-host-lifecycle/generated-contract.ts
var releaseContract = {
  cli: {
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
      "readiness.kernel",
      "readiness.storage",
      "readiness.synapse",
      "readiness.transport"
    ],
    check_statuses: [
      "pass",
      "fail",
      "warn",
      "skip"
    ],
    commands: [
      "start",
      "stop",
      "restart",
      "status",
      "doctor"
    ],
    effects: {
      fields: [
        "stop_committed",
        "start_committed"
      ],
      restart_only: true
    },
    exit_codes: {
      ok: 0,
      operational_failure: 1,
      usage: 2
    },
    readiness_states: {
      kernel: [
        "ready",
        "starting",
        "unavailable"
      ],
      storage: [
        "ready",
        "starting",
        "unavailable"
      ],
      synapse: [
        "ready",
        "starting",
        "degraded",
        "unsupported"
      ],
      transport: [
        "ready",
        "starting",
        "unavailable"
      ]
    },
    reasons: {
      failing_by_precedence: [
        {
          id: "internal_error",
          remediation: "report_bug"
        },
        {
          id: "no_data_dir",
          remediation: "set_data_directory"
        },
        {
          id: "unsupported_filesystem",
          remediation: "set_data_directory"
        },
        {
          id: "unsupported_platform",
          remediation: "use_supported_platform"
        },
        {
          id: "unsupported_install_layout",
          remediation: "use_supported_install_layout"
        },
        {
          id: "unsupported_state_schema",
          remediation: "align_versions"
        },
        {
          id: "native_payload_invalid",
          remediation: "reinstall_magic_context"
        },
        {
          id: "native_payload_missing",
          remediation: "install_native_payload"
        },
        {
          id: "insufficient_storage",
          remediation: "free_storage"
        },
        {
          id: "native_probe_unavailable",
          remediation: "run_daemon_restart"
        },
        {
          id: "wedged",
          remediation: "inspect_daemon_process"
        },
        {
          id: "publication_invalid",
          remediation: "inspect_daemon_process"
        },
        {
          id: "publication_stale",
          remediation: "inspect_daemon_process"
        },
        {
          id: "publication_missing",
          remediation: "inspect_daemon_process"
        },
        {
          id: "authentication_failed",
          remediation: "inspect_daemon_process"
        },
        {
          id: "unsupported_proof_version",
          remediation: "align_versions"
        },
        {
          id: "incompatible_control",
          remediation: "align_versions"
        },
        {
          id: "incompatible_daemon",
          remediation: "align_versions"
        },
        {
          id: "incompatible_module",
          remediation: "align_versions"
        },
        {
          id: "incompatible_epochs",
          remediation: "align_versions"
        },
        {
          id: "shutdown_timeout",
          remediation: "inspect_daemon_process"
        },
        {
          id: "startup_timeout",
          remediation: "inspect_daemon_process"
        },
        {
          id: "lifecycle_busy",
          remediation: "wait_and_retry"
        },
        {
          id: "storage_unavailable",
          remediation: "inspect_storage"
        },
        {
          id: "kernel_unavailable",
          remediation: "inspect_storage"
        },
        {
          id: "storage_starting",
          remediation: "wait_and_retry"
        },
        {
          id: "kernel_starting",
          remediation: "wait_and_retry"
        },
        {
          id: "synapse_degraded",
          remediation: "inspect_synapse"
        },
        {
          id: "synapse_starting",
          remediation: "wait_and_retry"
        },
        {
          id: "harness_unavailable",
          remediation: null,
          remediation_from_subreason: true
        },
        {
          id: "stopping",
          remediation: "wait_and_retry"
        },
        {
          id: "starting",
          remediation: "wait_and_retry"
        },
        {
          id: "not_running",
          remediation: "run_daemon_start"
        }
      ],
      non_failing: [
        "already_running",
        "already_stopped",
        "healthy",
        "kernel_lagging",
        "no_required_consumer",
        "started",
        "stopped",
        "synapse_unsupported"
      ],
      warn_remediations: {
        kernel_lagging: "inspect_kernel_projector"
      }
    },
    remediations: [
      "align_versions",
      "free_storage",
      "inspect_daemon_process",
      "inspect_kernel_projector",
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
      "wait_and_retry"
    ],
    result_schema: "magic-context.daemon/v1",
    states: [
      "unavailable",
      "stopped",
      "starting",
      "running",
      "stopping",
      "wedged"
    ]
  },
  coordination: {
    directory: ".mc-host-coordination",
    lifetime_lock: "lifetime.lock",
    transaction_lock: "transaction.lock"
  },
  credential_fingerprint: {
    canonicalization: "harness-provider-name-length-value/1",
    domain: "subc-broca-credential-v1"
  },
  epochs: {
    compartment_render: 2,
    memory_render: 2,
    profile_claude_code_anthropic: 2,
    state_sync: 1,
    tagger: 3
  },
  harness_unavailable: {
    reasons_by_precedence: [
      {
        id: "descriptor_absent",
        remediation: "restart_with_supported_harness"
      },
      {
        id: "descriptor_invalid",
        remediation: "restart_with_supported_harness"
      },
      {
        id: "closure_incomplete",
        remediation: "restart_with_supported_harness"
      },
      {
        id: "argument_variant_invalid",
        remediation: "restart_with_supported_harness"
      },
      {
        id: "provider_unsupported",
        remediation: null
      },
      {
        id: "auth_mechanism_unsupported",
        remediation: null
      },
      {
        id: "credential_missing",
        remediation: "restart_with_supported_harness"
      },
      {
        id: "credential_value_too_large",
        remediation: "restart_with_supported_harness"
      },
      {
        id: "credential_row_too_large",
        remediation: "restart_with_supported_harness"
      },
      {
        id: "credential_snapshot_mismatch",
        remediation: "restart_with_supported_harness"
      }
    ],
    row_cap_bytes: 65536,
    value_cap_bytes: 16384
  },
  install_layouts: [
    "bun_physical_link",
    "compiled_bun_external",
    "npm_hoisted",
    "npm_nested"
  ],
  layout: {
    connection_file: "subc-connection.json",
    managed_subtree: "cortexkit",
    runtime_directory: "run",
    storage_subdirectory: "magic-context"
  },
  model_lane: {
    execution_provider: "cpu",
    id: "gte-modernbert-base-f16",
    platforms: [
      "linux-x64-gnu"
    ],
    unsupported: {}
  },
  packages: {
    addons: [
      "@cortexkit/mc-shm-native"
    ],
    parents: [
      "@cortexkit/magic-context",
      "@cortexkit/opencode-magic-context",
      "@cortexkit/pi-magic-context"
    ],
    payloads: [
      "@cortexkit/mc-host-linux-x64-gnu"
    ],
    version: "0.38.0"
  },
  platforms: {
    supported: [
      {
        capabilities: {
          filesystem: [
            "atomic_same_filesystem_replacement",
            "cross_process_locks",
            "file_and_directory_fsync",
            "local_filesystem",
            "no_follow_link_semantics",
            "retained_object_execution"
          ],
          procfs_self_fd_exec: true
        },
        glibc_min: "2.28",
        kernel_min: "4.18",
        synapse: "certified_cpu",
        target: "linux-x64-gnu"
      }
    ],
    unsupported_reason: "unsupported_platform"
  },
  proof: {
    current_offers: [
      2
    ],
    current_version: 2,
    legacy_stop_only: {
      adjacent_release_only: true,
      missing_offer_inference: false,
      scope: "stop_only",
      version: 1
    },
    transcript_fields: [
      "offers",
      "selected_version",
      "daemon_ver",
      "client_nonce",
      "server_nonce",
      "daemon_id"
    ]
  },
  release: {
    id: "mc-host-release",
    version: "0.38.0"
  },
  schema: "magic-context.mc-host-release/v1",
  stop_provenance_schema: {
    genesis: {
      forbidden_fields: [
        "legacy_proof_version",
        "payload_manifest_digest",
        "predecessor_daemon_version",
        "predecessor_manifest",
        "predecessor_release_version"
      ],
      legacy_stop_authority: false,
      required_fields: [
        "release_version",
        "tag"
      ]
    },
    predecessor: {
      legacy_stop_authority: true,
      required_fields: [
        "legacy_proof_version",
        "payload_manifest_digest",
        "predecessor_daemon_version",
        "predecessor_manifest",
        "predecessor_release_version",
        "release_version",
        "tag",
        "target"
      ]
    },
    tag_field: "tag",
    tags: [
      "genesis",
      "predecessor"
    ]
  },
  versions: {
    daemon: "mc-host/0.1.0",
    modules: {
      broca: {
        range: {
          max_exclusive: "0.2.0",
          min_inclusive: "0.1.0"
        },
        version: "0.1.0"
      },
      magic_context: {
        range: {
          max_exclusive: "0.2.0",
          min_inclusive: "0.1.0"
        },
        version: "0.1.0"
      },
      synapse: {
        range: {
          max_exclusive: "0.2.0",
          min_inclusive: "0.1.0"
        },
        version: "0.1.0"
      }
    },
    supported_daemon_range: {
      max_exclusive: "0.2.0",
      min_inclusive: "0.1.0"
    },
    wire_protocol: 2
  }
};

// ../plugin/src/shared/data-path.ts
function getDataDir() {
  return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}
function getMagicContextTempDir(harness = getHarness()) {
  return path.join(os.tmpdir(), harness, "magic-context");
}
function getMagicContextLogPath(harness = getHarness()) {
  const envPath = process.env.MAGIC_CONTEXT_LOG_PATH?.trim();
  if (envPath)
    return envPath;
  return path.join(getMagicContextTempDir(harness), "magic-context.log");
}
function getProjectMagicContextDir(directory) {
  return path.join(directory, ".cortexkit", "magic-context");
}
var GITIGNORE_GUARD_OPEN = "# >>> cortexkit:magic-context";
var GITIGNORE_GUARD_CLOSE = "# <<< cortexkit:magic-context";
function ensureCortexKitArtifactGitignore(directory) {
  try {
    const cortexKitDir = path.join(directory, ".cortexkit");
    const gitignorePath = path.join(cortexKitDir, ".gitignore");
    let existing = "";
    if (existsSync(gitignorePath)) {
      existing = readFileSync(gitignorePath, "utf8");
      if (existing.includes(GITIGNORE_GUARD_OPEN))
        return;
    }
    const block = `${GITIGNORE_GUARD_OPEN}
magic-context/
${GITIGNORE_GUARD_CLOSE}
`;
    const needsLeadingNewline = existing.length > 0 && !existing.endsWith(`
`);
    const next = existing + (needsLeadingNewline ? `
` : "") + block;
    mkdirSync(cortexKitDir, { recursive: true });
    writeFileSync(gitignorePath, next, "utf8");
  } catch {}
}
function getProjectMagicContextHistorianDir(directory) {
  return path.join(getProjectMagicContextDir(directory), "historian");
}
function getMagicContextStorageDir() {
  if (!process.env.XDG_DATA_HOME) {
    const testDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    if (testDataDir) {
      return storageSubtreePath(testDataDir);
    }
    if (false) {}
  }
  return storageSubtreePath(getDataDir());
}
function storageSubtreePath(dataRoot) {
  return path.join(dataRoot, releaseContract.layout.managed_subtree, releaseContract.layout.storage_subdirectory);
}
var testBackstopDataRoot = null;
var testBackstopWarned = false;
function getTestBackstopDataRoot() {
  if (!testBackstopDataRoot) {
    testBackstopDataRoot = mkdtempSync(path.join(os.tmpdir(), "mc-test-db-backstop-"));
  }
  if (!testBackstopWarned) {
    testBackstopWarned = true;
    console.warn("[magic-context] TEST BACKSTOP: NODE_ENV=test with no MAGIC_CONTEXT_TEST_DATA_DIR " + `— redirecting storage to a throwaway temp dir (${testBackstopDataRoot}) so no ` + "test can touch the user's real shared database or daemon state. Wire " + "`[test] preload` in this package's bunfig.toml.");
  }
  return testBackstopDataRoot;
}

// ../plugin/src/shared/logger.ts
import * as fs from "node:fs";
import * as path2 from "node:path";
var isTestEnv = false;
var buffer = [];
var flushTimer = null;
var FLUSH_INTERVAL_MS = 500;
var BUFFER_SIZE_LIMIT = 50;
var swallowedWriteCount = 0;
var lastErrorMessage = null;
var lastErrorTime = null;
function recordSwallowedWrite(error) {
  try {
    swallowedWriteCount++;
    lastErrorMessage = error instanceof Error ? error.message : String(error);
    lastErrorTime = new Date().toISOString();
  } catch {}
}
function ensureDir(filePath) {
  fs.mkdirSync(path2.dirname(filePath), { recursive: true });
}
function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0)
    return;
  const data = buffer.join("");
  buffer = [];
  try {
    const logFile = getMagicContextLogPath();
    ensureDir(logFile);
    fs.appendFileSync(logFile, data);
  } catch (error) {
    recordSwallowedWrite(error);
  }
}
function scheduleFlush() {
  if (flushTimer)
    return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_INTERVAL_MS);
}
function log(message, data) {
  if (isTestEnv)
    return;
  try {
    const timestamp = new Date().toISOString();
    const serialized = data === undefined ? "" : data instanceof Error ? ` ${data.message}${data.stack ? `
${data.stack}` : ""}` : ` ${JSON.stringify(data)}`;
    buffer.push(`[${timestamp}] ${message}${serialized}
`);
    if (buffer.length >= BUFFER_SIZE_LIMIT) {
      flush();
    } else {
      scheduleFlush();
    }
  } catch {}
}
function sessionLog(sessionId, message, data) {
  log(`[magic-context][${sessionId}] ${message}`, data);
}
if (!isTestEnv) {
  process.on("exit", flush);
}

export { setHarness, getHarness, releaseContract, getDataDir, ensureCortexKitArtifactGitignore, getProjectMagicContextHistorianDir, getMagicContextStorageDir, getTestBackstopDataRoot, log, sessionLog };
