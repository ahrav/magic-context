import { describe, expect, it } from "bun:test";
import { registerExitAbort, unregisterExitAbort } from "./exit-abort-registry";

// The baseline excludes the registry listener, allowing tests to isolate it.
// The registry retains its process-wide listener, so the suite leaves it installed.
const baseline = process.listenerCount("exit");

/** The registry adds one 'exit' listener after baseline. */
function registryListener(): () => void {
    return process.listeners("exit").slice(baseline)[0] as () => void;
}

describe("exit-abort-registry", () => {
    it("adds exactly ONE process exit listener no matter how many controllers register", () => {
        registerExitAbort(new AbortController());
        registerExitAbort(new AbortController());
        registerExitAbort(new AbortController());
        expect(process.listenerCount("exit") - baseline).toBe(1);
    });

    it("aborts every registered controller when the exit listener fires", () => {
        const a = new AbortController();
        const b = new AbortController();
        registerExitAbort(a);
        registerExitAbort(b);

        // The test invokes the registry listener directly because emitting 'exit' ends the test process.
        // test process).
        registryListener()();

        expect(a.signal.aborted).toBe(true);
        expect(b.signal.aborted).toBe(true);
        expect(process.listenerCount("exit") - baseline).toBe(1);
    });

    it("does not abort a controller that was unregistered before exit", () => {
        const keep = new AbortController();
        const drop = new AbortController();
        registerExitAbort(keep);
        registerExitAbort(drop);
        unregisterExitAbort(drop);

        registryListener()();

        expect(keep.signal.aborted).toBe(true);
        expect(drop.signal.aborted).toBe(false);
    });
});
