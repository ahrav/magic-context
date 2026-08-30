import assert from "node:assert/strict";
import {
        activeNativeChannels,
        NativeChannel,
        probeCapabilities,
        supportsNativePlatform,
} from "../index.ts";

assert.equal(supportsNativePlatform("linux", "x64"), true);
assert.equal(supportsNativePlatform("darwin", "x64"), false);
assert.equal(supportsNativePlatform("darwin", "arm64"), false);
assert.equal(activeNativeChannels(), 0);
const capability = probeCapabilities();
if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
        assert.equal(capability.available, false);
        assert.equal(capability.reason, "node_detachment_unavailable");
}
assert.equal(
        activeNativeChannels(),
        0,
        "capability probe created a shared candidate",
);

if (capability.available) {
        const pair = NativeChannel.createTestPair();
        assert.equal(activeNativeChannels(), 2);
        pair.first.close();
        pair.second.close();
        assert.equal(activeNativeChannels(), 0);
        console.log(
                JSON.stringify({
                        capabilityOutcome: "ACTIVATED",
                        runtime: process.release.name,
                }),
        );
} else {
        assert.throws(
                () => NativeChannel.createTestPair(),
                /shared-memory native addon|shared-memory native startup failed/,
        );
        assert.equal(activeNativeChannels(), 0);
        console.log(
                JSON.stringify({
                        capabilityOutcome: "TERMINAL_STARTUP_FAILURE",
                        runtime: process.release.name,
                        reason: capability.reason,
                }),
        );
}
