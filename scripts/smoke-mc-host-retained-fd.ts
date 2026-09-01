import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { buildManagedStartupEnvelope } from "../packages/plugin/src/hooks/magic-context/module-transport";
import { stageBootstrap } from "../packages/plugin/src/shared/mc-host-lifecycle/bootstrap";
import { releaseContract } from "../packages/plugin/src/shared/mc-host-lifecycle/generated-contract";
import { runNativeLifecycle } from "../packages/plugin/src/shared/mc-host-lifecycle/native-launcher";

function required(name: string): string {
    const value = process.env[name];
    if (value === undefined || value.length === 0) {
        throw new Error(`${name} is required`);
    }
    return value;
}

async function main(): Promise<void> {
    const dataRoot = required("MC_HOST_CANARY_DATA_ROOT");
    // `stageBootstrap` resolves relative destination paths from the script's working directory.
    // `data_dir_path` ignores relative `XDG_DATA_HOME` values.
    // For a relative `XDG_DATA_HOME`, `data_dir_path` falls back to `$HOME/.local/share`.
    // Relative roots make staging and lifecycle state use different trees.
    // A relative data root can pollute `$HOME/.local/share`.
    if (!isAbsolute(dataRoot)) {
        throw new Error("MC_HOST_CANARY_DATA_ROOT must be absolute");
    }
    const launcher = required("MC_HOST_CANARY_LAUNCHER");
    const opencode = required("MC_HOST_CANARY_OPENCODE");
    const node = required("MC_HOST_CANARY_NODE");
    const piEntrypoint = required("MC_HOST_CANARY_PI_ENTRYPOINT");
    // `start` without `--payload-dir` requires an already-promoted current generation.
    // `stageBootstrap` writes to the bootstrap store, not the generation store.
    // On a clean canary root, no generation has been promoted.
    // `--payload-dir` lets `start` stage and promote a payload.
    const payloadDir = required("MC_HOST_CANARY_PAYLOAD_DIR");
    if (!isAbsolute(payloadDir)) {
        throw new Error("MC_HOST_CANARY_PAYLOAD_DIR must be absolute");
    }
    // `MC_HOST_CANARY_PAYLOAD_MANIFEST_SHA256` rejects promoted generations whose recorded source manifest differs.
    const payloadManifestDigest =
        process.env.MC_HOST_CANARY_PAYLOAD_MANIFEST_SHA256;
    const digest = createHash("sha256").update(readFileSync(launcher)).digest("hex");
    const retained = stageBootstrap({
        sourcePath: launcher,
        destDir: join(
            dataRoot,
            "cortexkit",
            "mc-host-bootstrap",
            releaseContract.release.version,
        ),
        expectedSha256: digest,
    });
    const opencodeEnvelope = buildManagedStartupEnvelope(
        "@cortexkit/opencode-magic-context",
        {},
        opencode,
    );
    const piEnvelope = buildManagedStartupEnvelope(
        "@cortexkit/pi-magic-context",
        {},
        node,
        piEntrypoint,
    );
    const envelope = {
        schema: 1 as const,
        ...("opencode" in opencodeEnvelope
            ? { opencode: opencodeEnvelope.opencode }
            : {}),
        ...("pi" in piEnvelope ? { pi: piEnvelope.pi } : {}),
    };
    assert.ok("opencode" in envelope, "OpenCode closure candidate is unavailable");
    assert.ok("pi" in envelope, "Pi closure candidate is unavailable");

    const env = {
        XDG_DATA_HOME: dataRoot,
        HOME: dirname(dirname(node)),
    };
    // A started daemon holds lifecycle locks under `dataRoot`.
    // A daemon left running makes later canaries sharing `dataRoot` fail.
    // `startAttempted` requires cleanup after every attempted start.
    // `startAttempted` must be set before awaiting `runNativeLifecycle`.
    // `runNativeLifecycle` can reject after starting the daemon because of a response timeout, output cap, or malformed reply.
    // An assignment after the await cannot run when `runNativeLifecycle` rejects after starting the daemon.
    // Stopping a daemon that never launched is harmless.
    let startAttempted = false;
    try {
        startAttempted = true;
        const start = await runNativeLifecycle(
            { kind: "retained-fd", fd: retained.fd },
            {
                command: "start",
                envelope,
                deadlineMs: 60_000,
                env,
                payloadDir,
                ...(payloadManifestDigest === undefined
                    ? {}
                    : { payloadManifestDigest }),
            },
        );
        assert.equal(start.ok, true);
        assert.equal(start.state, "running");

        const probe = await runNativeLifecycle(
            { kind: "retained-fd", fd: retained.fd },
            { command: "probe", deadlineMs: 5_000, env },
        );
        assert.equal(probe.ok, true);
        assert.equal(probe.state, "running");

        const stop = await runNativeLifecycle(
            { kind: "retained-fd", fd: retained.fd },
            { command: "stop", deadlineMs: 30_000, env },
        );
        assert.equal(stop.ok, true);
        assert.equal(stop.state, "stopped");
        // Clear `startAttempted` only after `stop` completes without assertion failures; otherwise leave it set for teardown retry.
        startAttempted = false;
        console.log("mc-host retained-fd smoke: PASS");
    } finally {
        if (startAttempted) {
            try {
                await runNativeLifecycle(
                    { kind: "retained-fd", fd: retained.fd },
                    { command: "stop", deadlineMs: 30_000, env },
                );
            } catch {
                // Teardown failures must not mask the original failure.
            }
        }
        closeSync(retained.fd);
    }
}

void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
