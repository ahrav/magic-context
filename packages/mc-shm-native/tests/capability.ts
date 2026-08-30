import assert from "node:assert/strict";
import {
        activeNativeChannels,
        NativeChannel,
        probeCapabilities,
} from "../index.ts";

assert.equal(activeNativeChannels(), 0);
const capability = probeCapabilities();
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
