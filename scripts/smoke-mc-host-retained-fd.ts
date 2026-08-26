import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
    try {
        const start = await runNativeLifecycle(
            { kind: "retained-fd", fd: retained.fd },
            { command: "start", envelope, deadlineMs: 60_000, env },
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
        console.log("mc-host retained-fd smoke: PASS");
    } finally {
        closeSync(retained.fd);
    }
}

void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
