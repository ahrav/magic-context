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
    const launcher = required("MC_HOST_CANARY_LAUNCHER");
    const opencode = required("MC_HOST_CANARY_OPENCODE");
    const node = required("MC_HOST_CANARY_NODE");
    const piEntrypoint = required("MC_HOST_CANARY_PI_ENTRYPOINT");
    // Native `start` without `--payload-dir` accepts only an already-promoted
    // current generation from the generation store. `stageBootstrap` populates
    // the separate bootstrap store, so on a clean canary root nothing has ever
    // promoted a generation and `start` answers `native_payload_missing`. The
    // payload root is what lets this run stage and promote one, which is also
    // the path a real install takes.
    const payloadDir = required("MC_HOST_CANARY_PAYLOAD_DIR");
    if (!isAbsolute(payloadDir)) {
        throw new Error("MC_HOST_CANARY_PAYLOAD_DIR must be absolute");
    }
    // Optional: when supplied, the daemon rejects a promoted generation whose
    // recorded source manifest disagrees, so a canary can pin which payload the
    // generation must come from instead of accepting whatever staged.
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
    // A started daemon holds the lifecycle locks under `dataRoot`, so leaving one
    // behind makes every later canary run on the same data root fail for the
    // previous run's residue. The flag therefore records that a start was
    // *attempted*, and is set before the await: `runNativeLifecycle` can reject
    // on a response timeout, an output cap, or a malformed reply after the
    // daemon is already up, and any assignment after the await is unreachable on
    // exactly that path. Stopping a daemon that never launched is harmless.
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
        // Only a stop that returned and asserted clean retires the obligation; a
        // wrong reported state still gets the teardown retry below.
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
                // Teardown is best-effort: the original failure is what the
                // operator needs to see, so it must not be masked here.
            }
        }
        closeSync(retained.fd);
    }
}

void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
