import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    buildContract,
    canonicalJson,
    evaluatePlatform,
    evaluateProofOffers,
    generate,
    OUTPUT_PATHS,
    REGISTRY_GATE_PATH,
    sha256Hex,
    validateContractSchema,
    validateRegistryGate,
    validateStopProvenance,
} from "./generate-mc-host-release-manifest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tempRoots: string[] = [];

function freshRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "mc-host-release-"));
    tempRoots.push(root);
    cpSync(join(repoRoot, REGISTRY_GATE_PATH), join(root, REGISTRY_GATE_PATH));
    return root;
}

afterEach(() => {
    while (tempRoots.length > 0) {
        const root = tempRoots.pop();
        if (root !== undefined) rmSync(root, { recursive: true, force: true });
    }
});

// biome-ignore lint/suspicious/noExplicitAny: tests mutate deep copies of the contract
function contractCopy(): any {
    return JSON.parse(JSON.stringify(buildContract()));
}

// biome-ignore lint/suspicious/noExplicitAny: tests mutate deep copies of the gate
function gateCopy(): any {
    return JSON.parse(readFileSync(join(repoRoot, REGISTRY_GATE_PATH), "utf8"));
}

describe("deterministic generation", () => {
    test("two clean generations are byte-identical with the same digest", () => {
        const rootA = freshRoot();
        const rootB = freshRoot();
        const first = generate(rootA, { check: false });
        const second = generate(rootB, { check: false });
        expect(first.digest).toBe(second.digest);
        for (const relative of Object.values(OUTPUT_PATHS)) {
            expect(readFileSync(join(rootA, relative), "utf8")).toBe(
                readFileSync(join(rootB, relative), "utf8"),
            );
        }
        expect(first.digest).toBe(sha256Hex(canonicalJson(buildContract())));
    });

    test("committed outputs match a clean regeneration (--check green)", () => {
        const result = generate(repoRoot, { check: true });
        expect(result.drift).toEqual([]);
    });

    test("check fails when the contract JSON is edited without regeneration", () => {
        const root = freshRoot();
        generate(root, { check: false });
        const jsonPath = join(root, OUTPUT_PATHS.contractJson);
        const edited = readFileSync(jsonPath, "utf8").replace(
            '"state_sync": 1',
            '"state_sync": 2',
        );
        expect(edited).not.toBe(readFileSync(jsonPath, "utf8"));
        writeFileSync(jsonPath, edited);
        const result = generate(root, { check: true });
        expect(
            result.drift.some((line) =>
                line.includes(OUTPUT_PATHS.contractJson),
            ),
        ).toBe(true);
    });

    test("check fails when a generated output is edited or missing", () => {
        const root = freshRoot();
        generate(root, { check: false });
        writeFileSync(join(root, OUTPUT_PATHS.typescript), "// tampered\n");
        rmSync(join(root, OUTPUT_PATHS.rust));
        const drift = generate(root, { check: true }).drift;
        expect(
            drift.some((line) => line.includes(OUTPUT_PATHS.typescript)),
        ).toBe(true);
        expect(drift.some((line) => line.includes(OUTPUT_PATHS.rust))).toBe(
            true,
        );
    });
});

describe("rust and typescript embeddings", () => {
    test("decode to the same canonical contract and digest", async () => {
        const generated = await import(
            "../packages/plugin/src/shared/mc-host-lifecycle/generated-contract"
        );
        const canonical = canonicalJson(buildContract());
        expect(generated.RELEASE_CONTRACT_JSON).toBe(canonical);
        expect(generated.RELEASE_CONTRACT_SHA256).toBe(sha256Hex(canonical));
        expect(canonicalJson(generated.releaseContract)).toBe(canonical);
        expect(JSON.parse(generated.RELEASE_CONTRACT_JSON)).toEqual(
            JSON.parse(JSON.stringify(buildContract())),
        );

        const rust = readFileSync(join(repoRoot, OUTPUT_PATHS.rust), "utf8");
        const jsonMatch = rust.match(
            /pub const RELEASE_CONTRACT_JSON: &str = "((?:[^"\\]|\\.)*)";/,
        );
        expect(jsonMatch).not.toBeNull();
        const rustJson = (jsonMatch as RegExpMatchArray)[1]
            .replace(/\\n/g, "\n")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\");
        expect(rustJson).toBe(canonical);
        const digestMatch = rust.match(
            /pub const RELEASE_CONTRACT_SHA256: &str = "([0-9a-f]{64})";/,
        );
        expect((digestMatch as RegExpMatchArray)[1]).toBe(sha256Hex(canonical));

        const committedJson = readFileSync(
            join(repoRoot, OUTPUT_PATHS.contractJson),
            "utf8",
        );
        expect(committedJson).toBe(`${canonical}\n`);
    });
});

describe("pre-build schema", () => {
    test("the committed contract passes strict validation", () => {
        validateContractSchema(contractCopy());
    });

    test("rejects binary/model/runtime/payload hash values", () => {
        const withHexValue = contractCopy();
        withHexValue.cli.reasons.non_failing.unshift("a".repeat(64));
        expect(() => validateContractSchema(withHexValue)).toThrow(
            /hash-like value/,
        );
    });

    test("rejects hash-bearing keys", () => {
        for (const key of ["payload_sha256", "binary_hash", "model_digest"]) {
            const withHashKey = contractCopy();
            withHashKey.model_lane[key] = "pinned-later";
            expect(() => validateContractSchema(withHashKey)).toThrow(
                /hash-bearing key|model_lane keys/,
            );
        }
    });

    test("rejects drift in closed unions, epochs, floors, and identifiers", () => {
        const mutations: [
            string,
            (contract: ReturnType<typeof contractCopy>) => void,
        ][] = [
            ["extra command", (c) => c.cli.commands.push("reload")],
            ["missing check id", (c) => c.cli.check_ids.pop()],
            ["unsorted check ids", (c) => c.cli.check_ids.reverse()],
            ["missing remediation", (c) => c.cli.remediations.pop()],
            [
                "missing failing reason",
                (c) => c.cli.reasons.failing_by_precedence.pop(),
            ],
            [
                "harness union reorder",
                (c) => c.harness_unavailable.reasons_by_precedence.reverse(),
            ],
            [
                "kernel floor drift",
                (c) => {
                    c.platforms.supported[2].kernel_min = "4.17.0";
                },
            ],
            [
                "macos floor drift",
                (c) => {
                    c.platforms.supported[0].os_min = "13";
                },
            ],
            [
                "dropped procfs capability",
                (c) => {
                    c.platforms.supported[2].capabilities.procfs_self_fd_exec = false;
                },
            ],
            [
                "model lane drift",
                (c) => {
                    c.model_lane.id = "some-other-model";
                },
            ],
            [
                "coordination rename",
                (c) => {
                    c.coordination.transaction_lock = "txn.lock";
                },
            ],
            [
                "fingerprint domain drift",
                (c) => {
                    c.credential_fingerprint.domain =
                        "subc-broca-credential-v2";
                },
            ],
            [
                "install layout drift",
                (c) => c.install_layouts.push("pnpm_virtual"),
            ],
            [
                "boolean epoch",
                (c) => {
                    c.epochs.state_sync = 0;
                },
            ],
            [
                "six epoch parts",
                (c) => {
                    c.epochs.extra = 1;
                },
            ],
            [
                "legacy proof not adjacent",
                (c) => {
                    c.proof.legacy_stop_only.version = 0;
                },
            ],
            [
                "legacy offered on general endpoint",
                (c) => c.proof.current_offers.push(1),
            ],
            [
                "daemon outside supported range",
                (c) => {
                    c.versions.supported_daemon_range.min_inclusive = "0.9.0";
                    c.versions.supported_daemon_range.max_exclusive = "1.0.0";
                },
            ],
            [
                "package/release version split",
                (c) => {
                    c.packages.version = "0.39.0";
                },
            ],
            [
                "genesis granted legacy authority",
                (c) => {
                    c.stop_provenance_schema.genesis.legacy_stop_authority = true;
                },
            ],
        ];
        for (const [label, mutate] of mutations) {
            const mutated = contractCopy();
            mutate(mutated);
            expect(() => validateContractSchema(mutated), label).toThrow();
        }
    });
});

describe("registry gate", () => {
    test("the committed gate passes", () => {
        validateRegistryGate(gateCopy(), buildContract());
    });

    test("generation fails when the gate file is absent", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-release-"));
        tempRoots.push(root);
        expect(() => generate(root, { check: false })).toThrow(
            /missing release\/mc-host-registry-gate/,
        );
    });

    test("each failing gate field blocks generation", () => {
        const failures: [
            string,
            (gate: ReturnType<typeof gateCopy>) => void,
            RegExp,
        ][] = [
            [
                "unowned name",
                (g) => {
                    g.packages[0].ownership_verified = false;
                },
                /ownership not verified/,
            ],
            [
                "absent trusted publisher",
                (g) => {
                    g.packages[3].trusted_publisher_configured = false;
                },
                /trusted publisher not configured/,
            ],
            [
                "unrevoked bootstrap credential",
                (g) => {
                    g.packages[3].bootstrap_credential_revoked = false;
                },
                /bootstrap credential not revoked/,
            ],
            [
                "missing reservation version",
                (g) => {
                    delete g.packages[3].reservation_version;
                },
                /missing inert reservation version/,
            ],
            [
                "reservation reused as the coordinated release",
                (g) => {
                    g.packages[3].reservation_version = g.release_version;
                },
                /must differ from the coordinated release version/,
            ],
            [
                "version already published for one name",
                (g) => {
                    g.packages[5].synchronized_version_unpublished = false;
                },
                /is not unpublished/,
            ],
            [
                "missing package entry",
                (g) => {
                    g.packages.pop();
                },
                /missing package entries/,
            ],
            [
                "unexpected package name",
                (g) => {
                    g.packages[1].name = "@cortexkit/unknown";
                },
                /unexpected package/,
            ],
            [
                "gate for a different release",
                (g) => {
                    g.release_version = "0.37.0";
                },
                /does not match contract/,
            ],
            [
                "unknown gate schema",
                (g) => {
                    g.schema = "magic-context.mc-host-registry-gate/v2";
                },
                /unknown gate schema/,
            ],
        ];
        for (const [label, mutate, pattern] of failures) {
            const gate = gateCopy();
            mutate(gate);
            expect(
                () => validateRegistryGate(gate, buildContract()),
                label,
            ).toThrow(pattern);
        }
    });

    test("a failing gate blocks file generation end to end", () => {
        const root = freshRoot();
        const gate = gateCopy();
        gate.packages[4].synchronized_version_unpublished = false;
        writeFileSync(join(root, REGISTRY_GATE_PATH), JSON.stringify(gate));
        expect(() => generate(root, { check: false })).toThrow(
            /is not unpublished/,
        );
    });
});

describe("platform floors", () => {
    const contract = buildContract();

    test("exact floors are supported with the declared synapse lane", () => {
        const linux = evaluatePlatform(contract, {
            os: "linux",
            arch: "x64",
            libc: "gnu",
            kernel: "4.18",
            glibc: "2.28",
            procfsSelfFdExec: true,
        });
        expect(linux).toEqual({
            supported: true,
            target: "linux-x64-gnu",
            synapse: "certified_cpu",
        });
        for (const arch of ["arm64", "x64"] as const) {
            const mac = evaluatePlatform(contract, {
                os: "darwin",
                arch,
                osVersion: "13.5",
            });
            expect(mac.supported).toBe(true);
            expect(mac.synapse).toBe("unsupported");
            expect(mac.synapseReason).toBe("synapse_unsupported");
        }
    });

    test("below-floor and missing-capability hosts are unsupported_platform", () => {
        const probes = [
            {
                os: "linux",
                arch: "x64",
                libc: "gnu",
                kernel: "4.17",
                glibc: "2.28",
                procfsSelfFdExec: true,
            },
            {
                os: "linux",
                arch: "x64",
                libc: "gnu",
                kernel: "4.18",
                glibc: "2.27",
                procfsSelfFdExec: true,
            },
            {
                os: "linux",
                arch: "x64",
                libc: "musl",
                kernel: "5.10",
                glibc: "2.31",
                procfsSelfFdExec: true,
            },
            {
                os: "linux",
                arch: "x64",
                libc: "gnu",
                kernel: "4.18",
                glibc: "2.28",
                procfsSelfFdExec: false,
            },
            {
                os: "linux",
                arch: "arm64",
                libc: "gnu",
                kernel: "5.10",
                glibc: "2.31",
                procfsSelfFdExec: true,
            },
            { os: "darwin", arch: "arm64", osVersion: "13.4" },
            { os: "win32", arch: "x64" },
        ] as const;
        for (const probe of probes) {
            expect(evaluatePlatform(contract, probe)).toEqual({
                supported: false,
                reason: "unsupported_platform",
            });
        }
    });
});

describe("proof offers", () => {
    const contract = buildContract();

    test("an offer list containing the current version is accepted", () => {
        expect(evaluateProofOffers(contract, [2])).toEqual({
            accepted: true,
            selected: 2,
        });
        expect(evaluateProofOffers(contract, [1, 2])).toEqual({
            accepted: true,
            selected: 2,
        });
    });

    test("absent and legacy-only offers are rejected", () => {
        expect(evaluateProofOffers(contract, undefined).accepted).toBe(false);
        expect(evaluateProofOffers(contract, []).accepted).toBe(false);
        expect(evaluateProofOffers(contract, [1]).accepted).toBe(false);
        expect(evaluateProofOffers(contract, [3]).accepted).toBe(false);
        expect(evaluateProofOffers(contract, ["2"]).accepted).toBe(false);
        expect(evaluateProofOffers(contract, [0, 2]).accepted).toBe(false);
    });
});

describe("stop-provenance schema", () => {
    const contract = buildContract();

    test("a genesis record binds the release identity and grants no legacy authority", () => {
        const result = validateStopProvenance(contract, {
            tag: "genesis",
            release_version: contract.release.version,
        });
        expect(result).toEqual({ valid: true, legacyStopAuthority: false });
    });

    test("genesis records carrying predecessor or proof authority are rejected", () => {
        for (const field of [
            "legacy_proof_version",
            "payload_manifest_digest",
            "predecessor_daemon_version",
            "predecessor_manifest",
            "predecessor_release_version",
        ]) {
            const result = validateStopProvenance(contract, {
                tag: "genesis",
                release_version: contract.release.version,
                [field]: "anything",
            });
            expect(result.valid).toBe(false);
            expect(result.legacyStopAuthority).toBe(false);
        }
        expect(
            validateStopProvenance(contract, {
                tag: "genesis",
                release_version: "0.0.1",
            }).valid,
        ).toBe(false);
    });

    test("predecessor records require every bound field", () => {
        const complete = {
            tag: "predecessor",
            release_version: contract.release.version,
            predecessor_release_version: "0.37.0",
            predecessor_daemon_version: "mc-host/0.0.9",
            legacy_proof_version: 1,
            payload_manifest_digest: "pinned-by-u6",
            predecessor_manifest: { files: [] },
            target: "linux-x64-gnu",
        };
        expect(validateStopProvenance(contract, complete)).toEqual({
            valid: true,
            legacyStopAuthority: true,
        });
        for (const field of Object.keys(complete)) {
            const partial: Record<string, unknown> = { ...complete };
            delete partial[field];
            expect(
                validateStopProvenance(contract, partial).valid,
                `missing ${field}`,
            ).toBe(false);
        }
        expect(
            validateStopProvenance(contract, { ...complete, extra: true })
                .valid,
        ).toBe(false);
    });

    test("untagged and unknown-tag records are rejected", () => {
        expect(validateStopProvenance(contract, {}).valid).toBe(false);
        expect(
            validateStopProvenance(contract, { tag: "rollback" }).valid,
        ).toBe(false);
        expect(validateStopProvenance(contract, null).valid).toBe(false);
    });
});

describe("dependency boundary", () => {
    test("cargo tree shows no mc-host -> mc-module edge", () => {
        const tree = execSync("cargo tree -p mc-host -e normal", {
            cwd: repoRoot,
            encoding: "utf8",
        });
        expect(tree.includes("mc-module")).toBe(false);
    });
});

describe("generated typescript location", () => {
    test("the shared lifecycle directory holds the generated contract", () => {
        mkdirSync(
            join(repoRoot, "packages/plugin/src/shared/mc-host-lifecycle"),
            {
                recursive: true,
            },
        );
        const content = readFileSync(
            join(repoRoot, OUTPUT_PATHS.typescript),
            "utf8",
        );
        expect(content).toContain(
            "@generated by scripts/generate-mc-host-release-manifest.ts",
        );
    });
});
