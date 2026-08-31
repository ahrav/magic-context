/**
 * The generator `scripts/generate-mc-host-release-manifest.ts` produces this file; developers must not edit it.
 * `bun scripts/generate-mc-host-release-manifest.ts` regenerates this file.
 * `bun scripts/generate-mc-host-release-manifest.ts --check` detects generated-file drift.
 *
 */

/**
 */
export const RELEASE_CONTRACT_JSON: string = "{\n  \"cli\": {\n    \"check_ids\": [\n      \"artifact.bootstrap\",\n      \"artifact.current_generation\",\n      \"artifact.input_qualification\",\n      \"artifact.native_payload\",\n      \"compatibility.control\",\n      \"compatibility.daemon\",\n      \"compatibility.epochs\",\n      \"compatibility.modules\",\n      \"compatibility.proof\",\n      \"credentials.broca\",\n      \"filesystem.capacity.bootstrap\",\n      \"filesystem.capacity.generation\",\n      \"filesystem.permissions\",\n      \"filesystem.support\",\n      \"install.layout\",\n      \"lifecycle.evidence\",\n      \"lifecycle.fences\",\n      \"lifecycle.publication\",\n      \"platform.support\",\n      \"readiness.storage\",\n      \"readiness.synapse\",\n      \"readiness.transport\"\n    ],\n    \"check_statuses\": [\n      \"pass\",\n      \"fail\",\n      \"warn\",\n      \"skip\"\n    ],\n    \"commands\": [\n      \"start\",\n      \"stop\",\n      \"restart\",\n      \"status\",\n      \"doctor\"\n    ],\n    \"effects\": {\n      \"fields\": [\n        \"stop_committed\",\n        \"start_committed\"\n      ],\n      \"restart_only\": true\n    },\n    \"exit_codes\": {\n      \"ok\": 0,\n      \"operational_failure\": 1,\n      \"usage\": 2\n    },\n    \"readiness_states\": {\n      \"storage\": [\n        \"ready\",\n        \"starting\",\n        \"unavailable\"\n      ],\n      \"synapse\": [\n        \"ready\",\n        \"starting\",\n        \"degraded\",\n        \"unsupported\"\n      ],\n      \"transport\": [\n        \"ready\",\n        \"starting\",\n        \"unavailable\"\n      ]\n    },\n    \"reasons\": {\n      \"failing_by_precedence\": [\n        {\n          \"id\": \"internal_error\",\n          \"remediation\": \"report_bug\"\n        },\n        {\n          \"id\": \"no_data_dir\",\n          \"remediation\": \"set_data_directory\"\n        },\n        {\n          \"id\": \"unsupported_filesystem\",\n          \"remediation\": \"set_data_directory\"\n        },\n        {\n          \"id\": \"unsupported_platform\",\n          \"remediation\": \"use_supported_platform\"\n        },\n        {\n          \"id\": \"unsupported_install_layout\",\n          \"remediation\": \"use_supported_install_layout\"\n        },\n        {\n          \"id\": \"unsupported_state_schema\",\n          \"remediation\": \"align_versions\"\n        },\n        {\n          \"id\": \"native_payload_invalid\",\n          \"remediation\": \"reinstall_magic_context\"\n        },\n        {\n          \"id\": \"native_payload_missing\",\n          \"remediation\": \"install_native_payload\"\n        },\n        {\n          \"id\": \"insufficient_storage\",\n          \"remediation\": \"free_storage\"\n        },\n        {\n          \"id\": \"native_probe_unavailable\",\n          \"remediation\": \"run_daemon_restart\"\n        },\n        {\n          \"id\": \"wedged\",\n          \"remediation\": \"inspect_daemon_process\"\n        },\n        {\n          \"id\": \"publication_invalid\",\n          \"remediation\": \"inspect_daemon_process\"\n        },\n        {\n          \"id\": \"publication_stale\",\n          \"remediation\": \"inspect_daemon_process\"\n        },\n        {\n          \"id\": \"publication_missing\",\n          \"remediation\": \"inspect_daemon_process\"\n        },\n        {\n          \"id\": \"authentication_failed\",\n          \"remediation\": \"inspect_daemon_process\"\n        },\n        {\n          \"id\": \"unsupported_proof_version\",\n          \"remediation\": \"align_versions\"\n        },\n        {\n          \"id\": \"incompatible_control\",\n          \"remediation\": \"align_versions\"\n        },\n        {\n          \"id\": \"incompatible_daemon\",\n          \"remediation\": \"align_versions\"\n        },\n        {\n          \"id\": \"incompatible_module\",\n          \"remediation\": \"align_versions\"\n        },\n        {\n          \"id\": \"incompatible_epochs\",\n          \"remediation\": \"align_versions\"\n        },\n        {\n          \"id\": \"shutdown_timeout\",\n          \"remediation\": \"inspect_daemon_process\"\n        },\n        {\n          \"id\": \"startup_timeout\",\n          \"remediation\": \"inspect_daemon_process\"\n        },\n        {\n          \"id\": \"lifecycle_busy\",\n          \"remediation\": \"wait_and_retry\"\n        },\n        {\n          \"id\": \"storage_unavailable\",\n          \"remediation\": \"inspect_storage\"\n        },\n        {\n          \"id\": \"storage_starting\",\n          \"remediation\": \"wait_and_retry\"\n        },\n        {\n          \"id\": \"synapse_degraded\",\n          \"remediation\": \"inspect_synapse\"\n        },\n        {\n          \"id\": \"synapse_starting\",\n          \"remediation\": \"wait_and_retry\"\n        },\n        {\n          \"id\": \"harness_unavailable\",\n          \"remediation\": null,\n          \"remediation_from_subreason\": true\n        },\n        {\n          \"id\": \"stopping\",\n          \"remediation\": \"wait_and_retry\"\n        },\n        {\n          \"id\": \"starting\",\n          \"remediation\": \"wait_and_retry\"\n        },\n        {\n          \"id\": \"not_running\",\n          \"remediation\": \"run_daemon_start\"\n        }\n      ],\n      \"non_failing\": [\n        \"already_running\",\n        \"already_stopped\",\n        \"healthy\",\n        \"started\",\n        \"stopped\",\n        \"synapse_unsupported\"\n      ]\n    },\n    \"remediations\": [\n      \"align_versions\",\n      \"free_storage\",\n      \"inspect_daemon_process\",\n      \"inspect_storage\",\n      \"inspect_synapse\",\n      \"install_native_payload\",\n      \"reinstall_magic_context\",\n      \"report_bug\",\n      \"restart_with_supported_harness\",\n      \"run_daemon_restart\",\n      \"run_daemon_start\",\n      \"set_data_directory\",\n      \"use_supported_install_layout\",\n      \"use_supported_platform\",\n      \"wait_and_retry\"\n    ],\n    \"result_schema\": \"magic-context.daemon/v1\",\n    \"states\": [\n      \"unavailable\",\n      \"stopped\",\n      \"starting\",\n      \"running\",\n      \"stopping\",\n      \"wedged\"\n    ]\n  },\n  \"coordination\": {\n    \"directory\": \".mc-host-coordination\",\n    \"lifetime_lock\": \"lifetime.lock\",\n    \"transaction_lock\": \"transaction.lock\"\n  },\n  \"credential_fingerprint\": {\n    \"canonicalization\": \"harness-provider-name-length-value/1\",\n    \"domain\": \"subc-broca-credential-v1\"\n  },\n  \"epochs\": {\n    \"compartment_render\": 2,\n    \"memory_render\": 2,\n    \"profile_claude_code_anthropic\": 2,\n    \"state_sync\": 1,\n    \"tagger\": 3\n  },\n  \"harness_unavailable\": {\n    \"reasons_by_precedence\": [\n      {\n        \"id\": \"descriptor_absent\",\n        \"remediation\": \"restart_with_supported_harness\"\n      },\n      {\n        \"id\": \"descriptor_invalid\",\n        \"remediation\": \"restart_with_supported_harness\"\n      },\n      {\n        \"id\": \"closure_incomplete\",\n        \"remediation\": \"restart_with_supported_harness\"\n      },\n      {\n        \"id\": \"argument_variant_invalid\",\n        \"remediation\": \"restart_with_supported_harness\"\n      },\n      {\n        \"id\": \"provider_unsupported\",\n        \"remediation\": null\n      },\n      {\n        \"id\": \"auth_mechanism_unsupported\",\n        \"remediation\": null\n      },\n      {\n        \"id\": \"credential_missing\",\n        \"remediation\": \"restart_with_supported_harness\"\n      },\n      {\n        \"id\": \"credential_value_too_large\",\n        \"remediation\": \"restart_with_supported_harness\"\n      },\n      {\n        \"id\": \"credential_row_too_large\",\n        \"remediation\": \"restart_with_supported_harness\"\n      },\n      {\n        \"id\": \"credential_snapshot_mismatch\",\n        \"remediation\": \"restart_with_supported_harness\"\n      }\n    ],\n    \"row_cap_bytes\": 65536,\n    \"value_cap_bytes\": 16384\n  },\n  \"install_layouts\": [\n    \"bun_physical_link\",\n    \"compiled_bun_external\",\n    \"npm_hoisted\",\n    \"npm_nested\"\n  ],\n  \"model_lane\": {\n    \"execution_provider\": \"cpu\",\n    \"id\": \"gte-modernbert-base-f16\",\n    \"platforms\": [\n      \"linux-x64-gnu\"\n    ],\n    \"unsupported\": {\n      \"darwin-arm64\": \"synapse_unsupported\",\n      \"darwin-x64\": \"synapse_unsupported\"\n    }\n  },\n  \"packages\": {\n    \"parents\": [\n      \"@cortexkit/magic-context\",\n      \"@cortexkit/opencode-magic-context\",\n      \"@cortexkit/pi-magic-context\"\n    ],\n    \"payloads\": [\n      \"@cortexkit/mc-host-darwin-arm64\",\n      \"@cortexkit/mc-host-darwin-x64\",\n      \"@cortexkit/mc-host-linux-x64-gnu\"\n    ],\n    \"version\": \"0.38.0\"\n  },\n  \"platforms\": {\n    \"supported\": [\n      {\n        \"capabilities\": {\n          \"dev_fd_exec\": true,\n          \"filesystem\": [\n            \"atomic_same_filesystem_replacement\",\n            \"cross_process_locks\",\n            \"file_and_directory_fsync\",\n            \"local_filesystem\",\n            \"no_follow_link_semantics\",\n            \"retained_object_execution\"\n          ]\n        },\n        \"os_min\": \"13.5\",\n        \"synapse\": \"unsupported\",\n        \"synapse_reason\": \"synapse_unsupported\",\n        \"target\": \"darwin-arm64\"\n      },\n      {\n        \"capabilities\": {\n          \"dev_fd_exec\": true,\n          \"filesystem\": [\n            \"atomic_same_filesystem_replacement\",\n            \"cross_process_locks\",\n            \"file_and_directory_fsync\",\n            \"local_filesystem\",\n            \"no_follow_link_semantics\",\n            \"retained_object_execution\"\n          ]\n        },\n        \"os_min\": \"13.5\",\n        \"synapse\": \"unsupported\",\n        \"synapse_reason\": \"synapse_unsupported\",\n        \"target\": \"darwin-x64\"\n      },\n      {\n        \"capabilities\": {\n          \"filesystem\": [\n            \"atomic_same_filesystem_replacement\",\n            \"cross_process_locks\",\n            \"file_and_directory_fsync\",\n            \"local_filesystem\",\n            \"no_follow_link_semantics\",\n            \"retained_object_execution\"\n          ],\n          \"procfs_self_fd_exec\": true\n        },\n        \"glibc_min\": \"2.28\",\n        \"kernel_min\": \"4.18\",\n        \"synapse\": \"certified_cpu\",\n        \"target\": \"linux-x64-gnu\"\n      }\n    ],\n    \"unsupported_reason\": \"unsupported_platform\"\n  },\n  \"proof\": {\n    \"current_offers\": [\n      2\n    ],\n    \"current_version\": 2,\n    \"legacy_stop_only\": {\n      \"adjacent_release_only\": true,\n      \"missing_offer_inference\": false,\n      \"scope\": \"stop_only\",\n      \"version\": 1\n    },\n    \"transcript_fields\": [\n      \"offers\",\n      \"selected_version\",\n      \"daemon_ver\",\n      \"client_nonce\",\n      \"server_nonce\",\n      \"daemon_id\"\n    ]\n  },\n  \"release\": {\n    \"id\": \"mc-host-release\",\n    \"version\": \"0.38.0\"\n  },\n  \"schema\": \"magic-context.mc-host-release/v1\",\n  \"stop_provenance_schema\": {\n    \"genesis\": {\n      \"forbidden_fields\": [\n        \"legacy_proof_version\",\n        \"payload_manifest_digest\",\n        \"predecessor_daemon_version\",\n        \"predecessor_manifest\",\n        \"predecessor_release_version\"\n      ],\n      \"legacy_stop_authority\": false,\n      \"required_fields\": [\n        \"release_version\",\n        \"tag\"\n      ]\n    },\n    \"predecessor\": {\n      \"legacy_stop_authority\": true,\n      \"required_fields\": [\n        \"legacy_proof_version\",\n        \"payload_manifest_digest\",\n        \"predecessor_daemon_version\",\n        \"predecessor_manifest\",\n        \"predecessor_release_version\",\n        \"release_version\",\n        \"tag\",\n        \"target\"\n      ]\n    },\n    \"tag_field\": \"tag\",\n    \"tags\": [\n      \"genesis\",\n      \"predecessor\"\n    ]\n  },\n  \"versions\": {\n    \"daemon\": \"mc-host/0.1.0\",\n    \"modules\": {\n      \"broca\": {\n        \"range\": {\n          \"max_exclusive\": \"0.2.0\",\n          \"min_inclusive\": \"0.1.0\"\n        },\n        \"version\": \"0.1.0\"\n      },\n      \"magic_context\": {\n        \"range\": {\n          \"max_exclusive\": \"0.2.0\",\n          \"min_inclusive\": \"0.1.0\"\n        },\n        \"version\": \"0.1.0\"\n      },\n      \"synapse\": {\n        \"range\": {\n          \"max_exclusive\": \"0.2.0\",\n          \"min_inclusive\": \"0.1.0\"\n        },\n        \"version\": \"0.1.0\"\n      }\n    },\n    \"supported_daemon_range\": {\n      \"max_exclusive\": \"0.2.0\",\n      \"min_inclusive\": \"0.1.0\"\n    },\n    \"wire_protocol\": 2\n  }\n}";

/* */
export const RELEASE_CONTRACT_SHA256 = "a2f7c195f769d369e4495c55806a1645a4ca575cad351b5f2b7a751d83b8eda4";

/* */
export const releaseContract = {
  "cli": {
    "check_ids": [
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
      "readiness.storage",
      "readiness.synapse",
      "readiness.transport"
    ],
    "check_statuses": [
      "pass",
      "fail",
      "warn",
      "skip"
    ],
    "commands": [
      "start",
      "stop",
      "restart",
      "status",
      "doctor"
    ],
    "effects": {
      "fields": [
        "stop_committed",
        "start_committed"
      ],
      "restart_only": true
    },
    "exit_codes": {
      "ok": 0,
      "operational_failure": 1,
      "usage": 2
    },
    "readiness_states": {
      "storage": [
        "ready",
        "starting",
        "unavailable"
      ],
      "synapse": [
        "ready",
        "starting",
        "degraded",
        "unsupported"
      ],
      "transport": [
        "ready",
        "starting",
        "unavailable"
      ]
    },
    "reasons": {
      "failing_by_precedence": [
        {
          "id": "internal_error",
          "remediation": "report_bug"
        },
        {
          "id": "no_data_dir",
          "remediation": "set_data_directory"
        },
        {
          "id": "unsupported_filesystem",
          "remediation": "set_data_directory"
        },
        {
          "id": "unsupported_platform",
          "remediation": "use_supported_platform"
        },
        {
          "id": "unsupported_install_layout",
          "remediation": "use_supported_install_layout"
        },
        {
          "id": "unsupported_state_schema",
          "remediation": "align_versions"
        },
        {
          "id": "native_payload_invalid",
          "remediation": "reinstall_magic_context"
        },
        {
          "id": "native_payload_missing",
          "remediation": "install_native_payload"
        },
        {
          "id": "insufficient_storage",
          "remediation": "free_storage"
        },
        {
          "id": "native_probe_unavailable",
          "remediation": "run_daemon_restart"
        },
        {
          "id": "wedged",
          "remediation": "inspect_daemon_process"
        },
        {
          "id": "publication_invalid",
          "remediation": "inspect_daemon_process"
        },
        {
          "id": "publication_stale",
          "remediation": "inspect_daemon_process"
        },
        {
          "id": "publication_missing",
          "remediation": "inspect_daemon_process"
        },
        {
          "id": "authentication_failed",
          "remediation": "inspect_daemon_process"
        },
        {
          "id": "unsupported_proof_version",
          "remediation": "align_versions"
        },
        {
          "id": "incompatible_control",
          "remediation": "align_versions"
        },
        {
          "id": "incompatible_daemon",
          "remediation": "align_versions"
        },
        {
          "id": "incompatible_module",
          "remediation": "align_versions"
        },
        {
          "id": "incompatible_epochs",
          "remediation": "align_versions"
        },
        {
          "id": "shutdown_timeout",
          "remediation": "inspect_daemon_process"
        },
        {
          "id": "startup_timeout",
          "remediation": "inspect_daemon_process"
        },
        {
          "id": "lifecycle_busy",
          "remediation": "wait_and_retry"
        },
        {
          "id": "storage_unavailable",
          "remediation": "inspect_storage"
        },
        {
          "id": "storage_starting",
          "remediation": "wait_and_retry"
        },
        {
          "id": "synapse_degraded",
          "remediation": "inspect_synapse"
        },
        {
          "id": "synapse_starting",
          "remediation": "wait_and_retry"
        },
        {
          "id": "harness_unavailable",
          "remediation": null,
          "remediation_from_subreason": true
        },
        {
          "id": "stopping",
          "remediation": "wait_and_retry"
        },
        {
          "id": "starting",
          "remediation": "wait_and_retry"
        },
        {
          "id": "not_running",
          "remediation": "run_daemon_start"
        }
      ],
      "non_failing": [
        "already_running",
        "already_stopped",
        "healthy",
        "started",
        "stopped",
        "synapse_unsupported"
      ]
    },
    "remediations": [
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
      "wait_and_retry"
    ],
    "result_schema": "magic-context.daemon/v1",
    "states": [
      "unavailable",
      "stopped",
      "starting",
      "running",
      "stopping",
      "wedged"
    ]
  },
  "coordination": {
    "directory": ".mc-host-coordination",
    "lifetime_lock": "lifetime.lock",
    "transaction_lock": "transaction.lock"
  },
  "credential_fingerprint": {
    "canonicalization": "harness-provider-name-length-value/1",
    "domain": "subc-broca-credential-v1"
  },
  "epochs": {
    "compartment_render": 2,
    "memory_render": 2,
    "profile_claude_code_anthropic": 2,
    "state_sync": 1,
    "tagger": 3
  },
  "harness_unavailable": {
    "reasons_by_precedence": [
      {
        "id": "descriptor_absent",
        "remediation": "restart_with_supported_harness"
      },
      {
        "id": "descriptor_invalid",
        "remediation": "restart_with_supported_harness"
      },
      {
        "id": "closure_incomplete",
        "remediation": "restart_with_supported_harness"
      },
      {
        "id": "argument_variant_invalid",
        "remediation": "restart_with_supported_harness"
      },
      {
        "id": "provider_unsupported",
        "remediation": null
      },
      {
        "id": "auth_mechanism_unsupported",
        "remediation": null
      },
      {
        "id": "credential_missing",
        "remediation": "restart_with_supported_harness"
      },
      {
        "id": "credential_value_too_large",
        "remediation": "restart_with_supported_harness"
      },
      {
        "id": "credential_row_too_large",
        "remediation": "restart_with_supported_harness"
      },
      {
        "id": "credential_snapshot_mismatch",
        "remediation": "restart_with_supported_harness"
      }
    ],
    "row_cap_bytes": 65536,
    "value_cap_bytes": 16384
  },
  "install_layouts": [
    "bun_physical_link",
    "compiled_bun_external",
    "npm_hoisted",
    "npm_nested"
  ],
  "model_lane": {
    "execution_provider": "cpu",
    "id": "gte-modernbert-base-f16",
    "platforms": [
      "linux-x64-gnu"
    ],
    "unsupported": {
      "darwin-arm64": "synapse_unsupported",
      "darwin-x64": "synapse_unsupported"
    }
  },
  "packages": {
    "parents": [
      "@cortexkit/magic-context",
      "@cortexkit/opencode-magic-context",
      "@cortexkit/pi-magic-context"
    ],
    "payloads": [
      "@cortexkit/mc-host-darwin-arm64",
      "@cortexkit/mc-host-darwin-x64",
      "@cortexkit/mc-host-linux-x64-gnu"
    ],
    "version": "0.38.0"
  },
  "platforms": {
    "supported": [
      {
        "capabilities": {
          "dev_fd_exec": true,
          "filesystem": [
            "atomic_same_filesystem_replacement",
            "cross_process_locks",
            "file_and_directory_fsync",
            "local_filesystem",
            "no_follow_link_semantics",
            "retained_object_execution"
          ]
        },
        "os_min": "13.5",
        "synapse": "unsupported",
        "synapse_reason": "synapse_unsupported",
        "target": "darwin-arm64"
      },
      {
        "capabilities": {
          "dev_fd_exec": true,
          "filesystem": [
            "atomic_same_filesystem_replacement",
            "cross_process_locks",
            "file_and_directory_fsync",
            "local_filesystem",
            "no_follow_link_semantics",
            "retained_object_execution"
          ]
        },
        "os_min": "13.5",
        "synapse": "unsupported",
        "synapse_reason": "synapse_unsupported",
        "target": "darwin-x64"
      },
      {
        "capabilities": {
          "filesystem": [
            "atomic_same_filesystem_replacement",
            "cross_process_locks",
            "file_and_directory_fsync",
            "local_filesystem",
            "no_follow_link_semantics",
            "retained_object_execution"
          ],
          "procfs_self_fd_exec": true
        },
        "glibc_min": "2.28",
        "kernel_min": "4.18",
        "synapse": "certified_cpu",
        "target": "linux-x64-gnu"
      }
    ],
    "unsupported_reason": "unsupported_platform"
  },
  "proof": {
    "current_offers": [
      2
    ],
    "current_version": 2,
    "legacy_stop_only": {
      "adjacent_release_only": true,
      "missing_offer_inference": false,
      "scope": "stop_only",
      "version": 1
    },
    "transcript_fields": [
      "offers",
      "selected_version",
      "daemon_ver",
      "client_nonce",
      "server_nonce",
      "daemon_id"
    ]
  },
  "release": {
    "id": "mc-host-release",
    "version": "0.38.0"
  },
  "schema": "magic-context.mc-host-release/v1",
  "stop_provenance_schema": {
    "genesis": {
      "forbidden_fields": [
        "legacy_proof_version",
        "payload_manifest_digest",
        "predecessor_daemon_version",
        "predecessor_manifest",
        "predecessor_release_version"
      ],
      "legacy_stop_authority": false,
      "required_fields": [
        "release_version",
        "tag"
      ]
    },
    "predecessor": {
      "legacy_stop_authority": true,
      "required_fields": [
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
    "tag_field": "tag",
    "tags": [
      "genesis",
      "predecessor"
    ]
  },
  "versions": {
    "daemon": "mc-host/0.1.0",
    "modules": {
      "broca": {
        "range": {
          "max_exclusive": "0.2.0",
          "min_inclusive": "0.1.0"
        },
        "version": "0.1.0"
      },
      "magic_context": {
        "range": {
          "max_exclusive": "0.2.0",
          "min_inclusive": "0.1.0"
        },
        "version": "0.1.0"
      },
      "synapse": {
        "range": {
          "max_exclusive": "0.2.0",
          "min_inclusive": "0.1.0"
        },
        "version": "0.1.0"
      }
    },
    "supported_daemon_range": {
      "max_exclusive": "0.2.0",
      "min_inclusive": "0.1.0"
    },
    "wire_protocol": 2
  }
} as const;
