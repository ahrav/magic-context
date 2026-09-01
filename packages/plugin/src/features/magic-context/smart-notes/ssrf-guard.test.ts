import { describe, expect, mock, test } from "bun:test";
import * as https from "node:https";

import {
    createPinnedLookup,
    createSmartNoteRequestAgent,
    guardedSmartNoteHttpGet,
    requestValidatedAddress,
    type SmartNoteResolver,
    validateSmartNoteHttpUrl,
} from "./ssrf-guard";
import { SmartNoteNetworkError } from "./types";

const signal = new AbortController().signal;

function resolver(rows: Array<{ address: string; family: 4 | 6 }>): SmartNoteResolver {
    return { lookup: async () => rows };
}

describe("smart-note SSRF guard", () => {
    test("requires https", async () => {
        await expect(validateSmartNoteHttpUrl("http://example.com", { signal })).rejects.toThrow(
            /https/i,
        );
        await expect(validateSmartNoteHttpUrl("file:///etc/passwd", { signal })).rejects.toThrow();
    });

    test("blocks alternate IPv4 loopback encodings canonicalized by URL", async () => {
        for (const host of ["127.1", "0177.0.0.1", "0x7f.0.0.1", "2130706433"]) {
            await expect(validateSmartNoteHttpUrl(`https://${host}/`, { signal })).rejects.toThrow(
                /non-global|internal/i,
            );
        }
    });

    test("blocks private, link-local, metadata, CGNAT, multicast, and documentation IPv4", async () => {
        for (const address of [
            "10.0.0.1",
            "172.16.0.1",
            "192.168.0.1",
            "169.254.169.254",
            "169.254.1.10",
            "100.64.0.1",
            "224.0.0.1",
            "192.0.2.10",
            "198.51.100.10",
            "203.0.113.10",
        ]) {
            await expect(
                validateSmartNoteHttpUrl(`https://${address}/`, { signal }),
            ).rejects.toThrow(/non-global|internal/i);
        }
    });

    test("rejects every IPv6 DNS answer before address classification", async () => {
        for (const address of [
            "2606:2800:220:1:248:1893:25c8:1946",
            "64:ff9b::a00:5",
            "2001:4860:abcd::a00:5",
            "3fff::1",
            "::ffff:127.0.0.1",
            "fe80::1",
            "fc00::1",
            "fd00:ec2::254",
            "ff02::1",
            "2001:db8::1",
        ]) {
            await expect(
                validateSmartNoteHttpUrl("https://ipv6-only.example.test/", {
                    signal,
                    resolver: resolver([{ address, family: 6 }]),
                }),
            ).rejects.toBeInstanceOf(SmartNoteNetworkError);
        }
    });

    test("allows a dual-stack host and pins only its public IPv4 answer", async () => {
        const validated = await validateSmartNoteHttpUrl("https://dual-stack.example.test/", {
            signal,
            resolver: resolver([
                { address: "93.184.216.34", family: 4 },
                { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
            ]),
        });

        expect(validated.addresses).toEqual([
            { address: "93.184.216.34", family: 4, classification: "global" },
        ]);
    });

    test("rejects DNS answers with any private IPv4 address", async () => {
        await expect(
            validateSmartNoteHttpUrl("https://example.test/", {
                signal,
                resolver: resolver([
                    { address: "93.184.216.34", family: 4 },
                    { address: "10.0.0.2", family: 4 },
                ]),
            }),
        ).rejects.toThrow(/non-global|internal/i);
    });

    test("allows public IPv4 DNS answers and preserves all validated candidates", async () => {
        const validated = await validateSmartNoteHttpUrl("https://example.test/path", {
            signal,
            resolver: resolver([
                { address: "93.184.216.34", family: 4 },
                { address: "1.1.1.1", family: 4 },
            ]),
        });
        expect(validated.addresses.map((a) => a.address)).toEqual(["93.184.216.34", "1.1.1.1"]);
    });

    test("stops after a terminal per-target failure", async () => {
        const contacted: string[] = [];
        const requestAddress = mock(async (_validation, candidate) => {
            contacted.push(candidate.address);
            throw new SmartNoteNetworkError("SMART_NOTE_NETWORK: response body too large", {
                terminal: true,
            });
        });

        const error = await guardedSmartNoteHttpGet("https://example.test/", {
            signal,
            resolver: resolver([
                { address: "93.184.216.34", family: 4 },
                { address: "1.1.1.1", family: 4 },
            ]),
            requestAddress,
        }).catch((error) => error);

        expect(error).toBeInstanceOf(SmartNoteNetworkError);
        expect((error as SmartNoteNetworkError).terminal).toBe(true);
        expect(contacted).toEqual(["93.184.216.34"]);
        expect(requestAddress.mock.calls).toHaveLength(1);
    });

    test("advances to the next address after a connection-level failure", async () => {
        const contacted: string[] = [];
        const requestAddress = mock(async (_validation, candidate) => {
            contacted.push(candidate.address);
            if (candidate.address === "93.184.216.34") {
                throw new SmartNoteNetworkError("SMART_NOTE_NETWORK: connect ECONNREFUSED");
            }
            return { status: 200, body: "ok" };
        });

        const response = await guardedSmartNoteHttpGet("https://example.test/", {
            signal,
            resolver: resolver([
                { address: "93.184.216.34", family: 4 },
                { address: "1.1.1.1", family: 4 },
            ]),
            requestAddress,
        });

        expect(response).toEqual({ status: 200, body: "ok" });
        expect(contacted).toEqual(["93.184.216.34", "1.1.1.1"]);
        expect(requestAddress.mock.calls).toHaveLength(2);
    });

    test("caps the validated address fanout", async () => {
        const addresses = [
            "93.184.216.34",
            "1.1.1.1",
            "8.8.8.8",
            "151.101.1.69",
            "13.107.42.14",
            "208.67.222.222",
        ].map((address) => ({ address, family: 4 as const }));
        const contacted: string[] = [];
        const requestAddress = mock(async (_validation, candidate) => {
            contacted.push(candidate.address);
            throw new SmartNoteNetworkError("SMART_NOTE_NETWORK: connect ECONNREFUSED");
        });

        const error = await guardedSmartNoteHttpGet("https://example.test/", {
            signal,
            resolver: resolver(addresses),
            requestAddress,
        }).catch((error) => error);

        expect(error).toBeInstanceOf(SmartNoteNetworkError);
        expect(contacted).toEqual(addresses.slice(0, 4).map((candidate) => candidate.address));
        expect(requestAddress.mock.calls).toHaveLength(4);
    });
});

describe("createPinnedLookup", () => {
    // Node 20+ https.request defaults to autoSelectFamily.
    // Happy-Eyeballs calls the lookup hook with { all: true }.
    // Node expects the array callback form when all is true.
    // lookupAndConnectMultiple calls results.sort() on the all:true callback result.
    // A non-array callback result makes `lookupAndConnectMultiple` throw when it calls `results.sort()`.
    test("returns the ARRAY form when Node asks for all candidates", () => {
        const hook = createPinnedLookup({ address: "93.184.216.34", family: 4 });
        let received: unknown;
        hook("example.test", { all: true }, (err, addresses) => {
            expect(err).toBeNull();
            received = addresses;
        });
        expect(received).toEqual([{ address: "93.184.216.34", family: 4 }]);
    });

    test("returns the legacy 3-arg form when all is not requested", () => {
        const hook = createPinnedLookup({ address: "1.1.1.1", family: 4 });
        let addr: unknown;
        let fam: unknown;
        hook("example.test", {}, (err, address, family) => {
            expect(err).toBeNull();
            addr = address;
            fam = family;
        });
        expect(addr).toBe("1.1.1.1");
        expect(fam).toBe(4);
    });

    test("pins to the validated IP without re-querying DNS", () => {
        const hook = createPinnedLookup({ address: "203.0.113.7", family: 4 });
        let received: unknown;
        hook("attacker-rebind.test", { all: true }, (_err, addresses) => {
            received = addresses;
        });
        expect(received).toEqual([{ address: "203.0.113.7", family: 4 }]);
    });
});

describe("guarded HTTPS request agent", () => {
    test("does not use a pre-seeded keep-alive global agent", async () => {
        // Every request routed through an Agent calls addRequest.
        const originalAddRequest = https.globalAgent.addRequest;
        const globalAddRequest = mock(originalAddRequest.bind(https.globalAgent));
        https.globalAgent.addRequest = globalAddRequest;
        try {
            const dedicated = createSmartNoteRequestAgent();
            expect(dedicated).not.toBe(https.globalAgent);
            expect(dedicated.keepAlive).toBe(false);
            expect(dedicated.maxSockets).toBe(1);
            dedicated.destroy();

            await expect(
                requestValidatedAddress(
                    {
                        url: new URL("https://example.test:1/"),
                        hostname: "example.test",
                        addresses: [],
                    },
                    { address: "127.0.0.1", family: 4, classification: "global" },
                    { signal, timeoutMs: 100, bodyLimitBytes: 1024 },
                ),
            ).rejects.toBeInstanceOf(SmartNoteNetworkError);
            expect(globalAddRequest).not.toHaveBeenCalled();
        } finally {
            https.globalAgent.addRequest = originalAddRequest;
        }
    });
});
