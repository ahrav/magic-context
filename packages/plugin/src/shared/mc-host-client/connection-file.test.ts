import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
    ConnectionFileError,
    MAX_CONNECTION_FILE_LEN,
    type ReadConnectionFileOptions,
    readConnectionFile,
    toExactByteArray,
} from "./connection-file";
import { Deadline } from "./deadline";

const execFileAsync = promisify(execFile);

let tmpDir = "";
let fileCounter = 0;

beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "mc-host-conn-file-"));
});

afterAll(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

function freshPath(name: string): string {
    fileCounter += 1;
    return path.join(tmpDir, `${fileCounter}-${name}`);
}

const KEY = Array.from({ length: 32 }, (_, i) => i);
const DAEMON_ID = Array.from({ length: 16 }, (_, i) => 0x60 + i);

function validJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        schema: 1,
        wire_version: 2,
        endpoints: [{ host: "127.0.0.1", port: 43_123 }],
        key: KEY,
        daemon_id: DAEMON_ID,
        pid: 4_242,
        daemon_ver: "mc-host/0.1.0",
        ...overrides,
    };
}

async function writePrivateFile(filePath: string, content: string | Uint8Array): Promise<void> {
    await writeFile(filePath, content, { mode: 0o600 });
}

function options(overrides: Partial<ReadConnectionFileOptions> = {}): ReadConnectionFileOptions {
    return { deadline: Deadline.start(60_000), ...overrides };
}

async function expectFailure(
    filePath: string,
    code: ConnectionFileError["code"],
    overrides: Partial<ReadConnectionFileOptions> = {},
): Promise<void> {
    const attempt = readConnectionFile(filePath, options(overrides));
    const error = await attempt.then(
        () => {
            throw new Error("readConnectionFile unexpectedly succeeded");
        },
        (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ConnectionFileError);
    expect((error as ConnectionFileError).code).toBe(code);
}

async function writeInvalid(
    json: Record<string, unknown>,
    code: ConnectionFileError["code"],
): Promise<void> {
    const filePath = freshPath("invalid.json");
    await writePrivateFile(filePath, JSON.stringify(json));
    await expectFailure(filePath, code);
}

describe("direct-file snapshot", () => {
    test("accepts a valid owner-only file and returns an immutable snapshot", async () => {
        const filePath = freshPath("valid.json");
        await writePrivateFile(filePath, JSON.stringify(validJson()));
        const snapshot = await readConnectionFile(filePath, options());
        expect(snapshot.endpoint).toEqual({ host: "127.0.0.1", port: 43_123 });
        expect(Array.from(snapshot.key)).toEqual(KEY);
        expect(Array.from(snapshot.daemonId)).toEqual(DAEMON_ID);
        expect(snapshot.pid).toBe(4_242);
        expect(snapshot.daemonVer).toBe("mc-host/0.1.0");
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.endpoint)).toBe(true);
    });

    test("accepts a whitespace-padded file of exactly 65,536 bytes", async () => {
        const filePath = freshPath("padded.json");
        const body = JSON.stringify(validJson()).padEnd(MAX_CONNECTION_FILE_LEN, " ");
        expect(body.length).toBe(65_536);
        await writePrivateFile(filePath, body);
        const snapshot = await readConnectionFile(filePath, options());
        expect(snapshot.endpoint.port).toBe(43_123);
    });

    test("rejects 65,537 bytes as oversize, not as a JSON failure", async () => {
        const filePath = freshPath("oversize.json");
        await writePrivateFile(
            filePath,
            JSON.stringify(validJson()).padEnd(MAX_CONNECTION_FILE_LEN + 1, " "),
        );
        await expectFailure(filePath, "oversize");
    });

    test("rejects a directory", async () => {
        const dirPath = freshPath("a-directory");
        await mkdir(dirPath, { mode: 0o700 });
        await expectFailure(dirPath, "not_regular_file");
    });

    test("rejects a FIFO without hanging", async () => {
        const fifoPath = freshPath("a-fifo");
        const created = await execFileAsync("mkfifo", ["-m", "600", fifoPath]).then(
            () => true,
            () => false,
        );
        if (!created) return;
        await expectFailure(fifoPath, "not_regular_file");
    });

    test("rejects a symlink at the connection-file path", async () => {
        const target = freshPath("link-target.json");
        await writePrivateFile(target, JSON.stringify(validJson()));
        const linkPath = freshPath("untrusted-link.json");
        await symlink(target, linkPath);
        await expectFailure(linkPath, "not_regular_file");
    });

    test("rejects any group or other permission bit", async () => {
        for (const mode of [0o644, 0o640, 0o604, 0o601]) {
            const filePath = freshPath(`mode-${mode.toString(8)}.json`);
            await writeFile(filePath, JSON.stringify(validJson()), { mode });
            await expectFailure(filePath, "insecure_permissions");
        }
    });

    test("rejects a file owned by another user", async () => {
        const filePath = freshPath("foreign.json");
        await writePrivateFile(filePath, JSON.stringify(validJson()));
        const uid = (process.getuid?.() ?? 0) + 1;
        await expectFailure(filePath, "foreign_owner", { uid });
    });

    test("permits exactly one restart after an atomic replacement", async () => {
        const filePath = freshPath("replaced-once.json");
        await writePrivateFile(filePath, JSON.stringify(validJson()));
        let attempts = 0;
        const afterOpen = async (): Promise<void> => {
            attempts += 1;
            if (attempts > 1) return;
            const replacement = freshPath("replacement.json");
            await writePrivateFile(
                replacement,
                JSON.stringify(validJson({ endpoints: [{ host: "127.0.0.1", port: 50_000 }] })),
            );
            await rename(replacement, filePath);
        };
        const snapshot = await readConnectionFile(filePath, options({ afterOpen }));
        expect(attempts).toBe(2);
        expect(snapshot.endpoint.port).toBe(50_000);
    });

    test("fails closed on a second replacement", async () => {
        const filePath = freshPath("replaced-twice.json");
        await writePrivateFile(filePath, JSON.stringify(validJson()));
        const afterOpen = async (): Promise<void> => {
            const replacement = freshPath("replacement.json");
            await writePrivateFile(replacement, JSON.stringify(validJson()));
            await rename(replacement, filePath);
        };
        await expectFailure(filePath, "replaced_during_read", { afterOpen });
    });

    test("classifies a missing file as open_failed discovery churn", async () => {
        // A raw ENOENT here would escape the ConnectionFileError retry
        // allowlist and permanently stop a recovery episode whose daemon
        // was mid-republication (unlink before the fresh file lands).
        await expectFailure(freshPath("absent.json"), "open_failed");
    });

    test("classifies a permanent stat failure as stat_failed, not churn", async () => {
        const filePath = freshPath("not-a-dir.json");
        await writePrivateFile(filePath, JSON.stringify(validJson()));
        // A regular file used as a path component is a permanent
        // configuration error (ENOTDIR), not republication churn: it must
        // stop a recovery episode instead of retrying to its deadline.
        await expectFailure(path.join(filePath, "child.json"), "stat_failed");
    });

    test("classifies an unlink during the snapshot as discovery churn", async () => {
        const filePath = freshPath("unlinked-mid-read.json");
        await writePrivateFile(filePath, JSON.stringify(validJson()));
        const afterOpen = async (): Promise<void> => {
            await rm(filePath, { force: true });
        };
        // First attempt: the post-read stat reports the removal as
        // `replaced_during_read`; the one-restart rule retries, and the
        // restart's initial stat reports the still-absent file as
        // `open_failed`. Both are retryable churn codes for callers.
        await expectFailure(filePath, "open_failed", { afterOpen });
    });

    test("fails closed on win32 before any filesystem work", async () => {
        await expectFailure(path.join(tmpDir, "never-touched.json"), "unsupported_platform", {
            platform: "win32",
        });
    });

    test("fails closed on an already-expired deadline", async () => {
        const filePath = freshPath("deadline.json");
        await writePrivateFile(filePath, JSON.stringify(validJson()));
        await expectFailure(filePath, "deadline_expired", {
            deadline: Deadline.start(0, () => 0),
        });
    });
});

describe("snapshot JSON validation", () => {
    test("rejects invalid UTF-8 bytes", async () => {
        const filePath = freshPath("bad-utf8.json");
        await writePrivateFile(filePath, Uint8Array.from([0x7b, 0xff, 0xfe, 0x7d]));
        await expectFailure(filePath, "invalid_utf8");
    });

    test("rejects malformed JSON and non-object roots", async () => {
        const badJson = freshPath("not-json.json");
        await writePrivateFile(badJson, "{nope");
        await expectFailure(badJson, "invalid_json");
        const arrayRoot = freshPath("array-root.json");
        await writePrivateFile(arrayRoot, "[1,2,3]");
        await expectFailure(arrayRoot, "invalid_json");
    });

    test("rejects a missing or wrong schema", async () => {
        await writeInvalid(validJson({ schema: 2 }), "invalid_schema");
        await writeInvalid(validJson({ schema: "1" }), "invalid_schema");
        const noSchema = validJson();
        delete noSchema.schema;
        await writeInvalid(noSchema, "invalid_schema");
    });

    test("requires wire_version to be exactly 2 and rejects every other value", async () => {
        const absent = validJson();
        delete absent.wire_version;
        await writeInvalid(absent, "invalid_wire_version");
        await writeInvalid(validJson({ wire_version: 3 }), "invalid_wire_version");
        await writeInvalid(validJson({ wire_version: null }), "invalid_wire_version");
        await writeInvalid(validJson({ wire_version: "2" }), "invalid_wire_version");
        await writeInvalid(validJson({ wire_version: 1 }), "invalid_wire_version");
    });

    test("rejects hostnames, wildcard, IPv6, and invalid ports", async () => {
        const endpoints = (host: unknown, port: unknown): Record<string, unknown> =>
            validJson({ endpoints: [{ host, port }] });
        await writeInvalid(endpoints("localhost", 43_123), "invalid_endpoint");
        await writeInvalid(endpoints("0.0.0.0", 43_123), "invalid_endpoint");
        await writeInvalid(endpoints("::1", 43_123), "invalid_endpoint");
        await writeInvalid(endpoints("127.0.0.1", 0), "invalid_endpoint");
        await writeInvalid(endpoints("127.0.0.1", 65_536), "invalid_endpoint");
        await writeInvalid(endpoints("127.0.0.1", 1.5), "invalid_endpoint");
        await writeInvalid(endpoints("127.0.0.1", "43123"), "invalid_endpoint");
        await writeInvalid(validJson({ endpoints: [] }), "invalid_endpoint");
        await writeInvalid(validJson({ endpoints: "127.0.0.1:1" }), "invalid_endpoint");
    });

    test("rejects key and daemon_id byte-array violations", async () => {
        await writeInvalid(validJson({ key: KEY.slice(0, 31) }), "invalid_key");
        await writeInvalid(validJson({ key: [...KEY, 0] }), "invalid_key");
        await writeInvalid(validJson({ key: [1.5, ...KEY.slice(1)] }), "invalid_key");
        await writeInvalid(validJson({ key: [-1, ...KEY.slice(1)] }), "invalid_key");
        await writeInvalid(validJson({ key: [256, ...KEY.slice(1)] }), "invalid_key");
        await writeInvalid(validJson({ key: [null, ...KEY.slice(1)] }), "invalid_key");
        await writeInvalid(validJson({ key: "not-an-array" }), "invalid_key");
        await writeInvalid(validJson({ daemon_id: DAEMON_ID.slice(0, 15) }), "invalid_daemon_id");
        await writeInvalid(
            validJson({ daemon_id: [256, ...DAEMON_ID.slice(1)] }),
            "invalid_daemon_id",
        );
    });

    test("rejects an unsafe or missing pid", async () => {
        await writeInvalid(validJson({ pid: 2 ** 53 }), "invalid_pid");
        await writeInvalid(validJson({ pid: "4242" }), "invalid_pid");
        await writeInvalid(validJson({ pid: 0 }), "invalid_pid");
        await writeInvalid(validJson({ pid: -1 }), "invalid_pid");
        const noPid = validJson();
        delete noPid.pid;
        await writeInvalid(noPid, "invalid_pid");
    });

    test("rejects an empty or missing daemon_ver", async () => {
        await writeInvalid(validJson({ daemon_ver: "" }), "invalid_daemon_ver");
        await writeInvalid(validJson({ daemon_ver: 7 }), "invalid_daemon_ver");
    });
});

describe("toExactByteArray", () => {
    test("accepts an exact-length dense integer array", () => {
        const bytes = toExactByteArray([0, 128, 255], 3);
        expect(bytes).not.toBeNull();
        expect(Array.from(bytes as Uint8Array)).toEqual([0, 128, 255]);
    });

    test("rejects sparse arrays even when length matches", () => {
        const sparse = new Array(3);
        sparse[0] = 1;
        sparse[2] = 2;
        expect(toExactByteArray(sparse, 3)).toBeNull();
        expect(toExactByteArray(new Array(32), 32)).toBeNull();
    });

    test("rejects wrong length, fractions, negatives, over-255, and non-numbers", () => {
        expect(toExactByteArray([1, 2], 3)).toBeNull();
        expect(toExactByteArray([1, 2, 3, 4], 3)).toBeNull();
        expect(toExactByteArray([1.5, 0, 0], 3)).toBeNull();
        expect(toExactByteArray([-1, 0, 0], 3)).toBeNull();
        expect(toExactByteArray([256, 0, 0], 3)).toBeNull();
        expect(toExactByteArray([null, 0, 0], 3)).toBeNull();
        expect(toExactByteArray(["1", 0, 0], 3)).toBeNull();
        expect(toExactByteArray("123", 3)).toBeNull();
    });
});
