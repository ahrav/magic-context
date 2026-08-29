import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The producer of every payload_manifest_digest in the parent trust index.
// Fixture digests are computed with THIS implementation so the test fails if
// owner.ts's verifier canonicalization ever drifts from the release build's.
import { canonicalJson } from "../../../../../scripts/generate-mc-host-release-manifest";
import {
    canonicalPayloadManifestJson,
    type PayloadTrustIndex,
    prepareManagedLaunchTarget,
} from "./owner";

const roots: string[] = [];

function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "mc-host-owner-"));
    roots.push(root);
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(bytes: Buffer | string): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function fixture(): {
    root: string;
    dataRoot: string;
    parentRoot: string;
    trustIndex: PayloadTrustIndex;
} {
    const root = tempRoot();
    const dataRoot = join(root, "data");
    const parentRoot = join(root, "parent");
    const packageDir = join(parentRoot, "node_modules", "@cortexkit", "mc-host-linux-x64-gnu");
    const launcher = Buffer.from("\x7fELF qualified launcher\n");
    const model = Buffer.from("qualified model bytes\n");
    const launcherDigest = sha256(launcher);
    const manifest = {
        schema: "magic-context.mc-host-payload-manifest/v1",
        package: {
            name: "@cortexkit/mc-host-linux-x64-gnu",
            version: "0.38.0",
            target: "linux-x64-gnu",
        },
        launcher: "payload/bin/ck-mc-host",
        files: [
            {
                path: "payload/bin/ck-mc-host",
                type: "file",
                size: launcher.length,
                mode: "755",
                sha256: launcherDigest,
            },
            {
                path: "payload/model/model.onnx",
                type: "file",
                size: model.length,
                mode: "644",
                sha256: sha256(model),
            },
        ],
    };
    mkdirSync(join(packageDir, "payload", "bin"), { recursive: true, mode: 0o700 });
    mkdirSync(join(packageDir, "payload", "model"), { recursive: true, mode: 0o700 });
    writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({
            name: "@cortexkit/mc-host-linux-x64-gnu",
            version: "0.38.0",
        }),
    );
    writeFileSync(join(packageDir, "payload", "bin", "ck-mc-host"), launcher, {
        mode: 0o755,
    });
    writeFileSync(join(packageDir, "payload", "model", "model.onnx"), model, {
        mode: 0o644,
    });
    writeFileSync(join(packageDir, "payload-manifest.json"), `${canonicalJson(manifest)}\n`);
    const trustIndex: PayloadTrustIndex = {
        schema: "magic-context.mc-host-payload-index/v1",
        release: { id: "mc-host-release", version: "0.38.0" },
        entries: [
            {
                package: "@cortexkit/mc-host-linux-x64-gnu",
                version: "0.38.0",
                target: "linux-x64-gnu",
                qualified: true,
                payload_manifest_digest: sha256(canonicalJson(manifest)),
                bootstrap_launcher_digest: launcherDigest,
            },
        ],
    };
    return { root, dataRoot, parentRoot, trustIndex };
}

describe("managed lifecycle owner", () => {
    test("verifier canonicalization is byte-identical to the release producer", () => {
        const sample = {
            zeta: [{ b: 1, a: [2, null, "x"] }, 3],
            alpha: { nested: { z: true, a: "é\u0000" }, empty: {} },
            num: 1.5,
        };
        expect(canonicalPayloadManifestJson(sample)).toBe(canonicalJson(sample));
    });

    test("qualified package bytes stage one retained descriptor", () => {
        const f = fixture();
        const target = prepareManagedLaunchTarget({
            dataRoot: f.dataRoot,
            declaringParentRoot: f.parentRoot,
            target: "linux-x64-gnu",
            trustIndex: f.trustIndex,
            allowPackageLookup: true,
        });

        expect(target?.kind).toBe("retained-fd");
        expect(target?.retained.path).toContain(f.trustIndex.entries[0]?.bootstrap_launcher_digest);
    });

    test("retained bootstrap works after the package tree is removed", () => {
        const f = fixture();
        const first = prepareManagedLaunchTarget({
            dataRoot: f.dataRoot,
            declaringParentRoot: f.parentRoot,
            target: "linux-x64-gnu",
            trustIndex: f.trustIndex,
            allowPackageLookup: true,
        });
        expect(first).not.toBeNull();
        rmSync(join(f.parentRoot, "node_modules"), { recursive: true, force: true });

        const retained = prepareManagedLaunchTarget({
            dataRoot: f.dataRoot,
            declaringParentRoot: f.parentRoot,
            target: "linux-x64-gnu",
            trustIndex: f.trustIndex,
            allowPackageLookup: false,
        });

        expect(retained?.kind).toBe("retained-fd");
    });

    test("observational resolution never looks up or stages a package", () => {
        const f = fixture();
        const target = prepareManagedLaunchTarget({
            dataRoot: f.dataRoot,
            declaringParentRoot: join(f.root, "missing-parent"),
            target: "linux-x64-gnu",
            trustIndex: f.trustIndex,
            allowPackageLookup: false,
        });

        expect(target).toBeNull();
    });

    test("unqualified metadata can never produce an executable target", () => {
        const f = fixture();
        f.trustIndex.entries[0] = {
            ...f.trustIndex.entries[0]!,
            qualified: false,
            payload_manifest_digest: null,
            bootstrap_launcher_digest: null,
        };

        expect(
            prepareManagedLaunchTarget({
                dataRoot: f.dataRoot,
                declaringParentRoot: f.parentRoot,
                target: "linux-x64-gnu",
                trustIndex: f.trustIndex,
                allowPackageLookup: true,
            }),
        ).toBeNull();
    });

    test("manifest or launcher drift fails closed without staging", () => {
        const f = fixture();
        f.trustIndex.entries[0] = {
            ...f.trustIndex.entries[0]!,
            payload_manifest_digest: "f".repeat(64),
        };

        expect(() =>
            prepareManagedLaunchTarget({
                dataRoot: f.dataRoot,
                declaringParentRoot: f.parentRoot,
                target: "linux-x64-gnu",
                trustIndex: f.trustIndex,
                allowPackageLookup: true,
            }),
        ).toThrow(/manifest digest/);
    });

    test("non-launcher payload mutation and symlink substitution fail before staging", () => {
        const f = fixture();
        const packageDir = join(
            f.parentRoot,
            "node_modules",
            "@cortexkit",
            "mc-host-linux-x64-gnu",
        );
        const modelPath = join(packageDir, "payload", "model", "model.onnx");
        writeFileSync(modelPath, "mutated model bytes\n", { mode: 0o644 });
        expect(() =>
            prepareManagedLaunchTarget({
                dataRoot: f.dataRoot,
                declaringParentRoot: f.parentRoot,
                target: "linux-x64-gnu",
                trustIndex: f.trustIndex,
                allowPackageLookup: true,
            }),
        ).toThrow(/payload file/);

        rmSync(modelPath);
        symlinkSync(join(packageDir, "payload", "bin", "ck-mc-host"), modelPath);
        expect(() =>
            prepareManagedLaunchTarget({
                dataRoot: f.dataRoot,
                declaringParentRoot: f.parentRoot,
                target: "linux-x64-gnu",
                trustIndex: f.trustIndex,
                allowPackageLookup: true,
            }),
        ).toThrow(/without following links/);
    });
});
