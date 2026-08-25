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
                /capability unavailable/,
        );
        assert.equal(activeNativeChannels(), 0);
        console.log(
                JSON.stringify({
                        capabilityOutcome: "OMITTED_WITHOUT_CANDIDATE",
                        runtime: process.release.name,
                        reason: capability.reason,
                }),
        );
}
