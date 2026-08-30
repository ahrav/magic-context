import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { findArchitectureViolations } from "./check-mc-shm-architecture";

const roots = [
    "crates/mc-host/src/lib.rs",
    "crates/mc-shm-transport/src/lib.rs",
    "packages/mc-shm-native/src/lib.rs",
    "packages/mc-shm-native/index.ts",
    "packages/plugin/src/shared/mc-host-client/client.ts",
    "packages/plugin/src/shared/mc-host-lifecycle/contract.ts",
    "Cargo.toml",
    "Cargo.lock",
    "crates/mc-host/Cargo.toml",
    "crates/mc-shm-transport/Cargo.toml",
    "packages/mc-shm-native/package.json",
    "packages/plugin/package.json",
];

function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "mc-shm-architecture-"));
    for (const path of roots) {
        const target = join(root, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, "mandatory ring\n");
    }
    return root;
}

describe("mandatory ring architecture audit", () => {
    test.each([
        ["crates/mc-host/src/tcp_frame_channel.rs", "pub struct TcpFrameChannel;"],
        ["crates/mc-host/src/client.rs", "let stream: TcpStream;"],
        ["packages/plugin/src/shared/mc-host-client/client.ts", 'const op = "transport.negotiate";'],
        ["packages/plugin/src/shared/mc-host-client/client.ts", "const fallback_reason = true;"],
        ["crates/mc-host/src/ring_transport.rs", "let id: BackendId;"],
        ["crates/mc-shm-transport/src/arena.rs", "fn prefault_arena() {}"],
        ["crates/mc-shm-transport/src/arena.rs", "let error = PrefaultFailed;"],
        ["crates/mc-shm-transport/src/descriptor.rs", "enum SchedulingMode { Poll }"],
        ["crates/mc-shm-transport/src/backend/ring.rs", "std::thread::sleep(Duration::from_micros(50));"],
        ["packages/plugin/src/shared/mc-host-client/client.ts", "setInterval(() => pollRing(), 1);"],
        ["packages/mc-shm-native/src/lib.rs", "napi_get_uv_event_loop(env, &mut loop_ptr);"],
        ["packages/mc-shm-native/src/lib.rs", "uv_poll_init(loop_ptr, &mut handle, fd);"],
        ["crates/mc-shm-transport/Cargo.toml", 'iceoryx2 = "0.9"'],
    ])("rejects %s", (path, source) => {
        const root = fixture();
        const target = join(root, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, source);
        expect(findArchitectureViolations(root)).not.toEqual([]);
    });

    test("does not reject unrelated fallback/provider code or historical benchmark evidence", () => {
        const root = fixture();
        writeFileSync(
            join(root, "packages/plugin/src/shared/mc-host-client/client.ts"),
            "const modelFallback = true; const credentialProvider = 'local';\n",
        );
        const historical = join(root, "docs/perf/frozen-tcp-baseline.json");
        mkdirSync(dirname(historical), { recursive: true });
        writeFileSync(historical, '{"transport":"tcp","role":"baseline"}\n');
        expect(findArchitectureViolations(root)).toEqual([]);
    });

    test("missing an audit root fails closed", () => {
        const root = fixture();
        const missing = join(root, "packages/mc-shm-native/index.ts");
        rmSync(missing);
        expect(findArchitectureViolations(root)).toContainEqual({
            path: "packages/mc-shm-native/index.ts",
            rule: "required audit input missing",
        });
    });
});
