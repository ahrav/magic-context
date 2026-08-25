import { describe, expect, test } from "bun:test";
import {
    ACTIVATION_CORRELATION,
    ACTIVATION_TOKEN_LEN,
    activateResponseJson,
    COMMIT_CORRELATION,
    commitRequestJson,
    commitResponseJson,
    decodeActivateRequest,
    decodeActivateResponse,
    decodeCommitRequest,
    decodeCommitResponse,
    decodeNegotiateRequest,
    decodeNegotiateResponse,
    encodeActivateRequest,
    encodeNegotiateRequest,
    encodeNegotiateResponse,
    FALLBACK_REASONS,
    FIRST_APPLICATION_CORRELATION,
    isValidActivationToken,
    MAX_OFFERS,
    MAX_OPAQUE_BYTES,
    MAX_OPAQUE_DEPTH,
    MAX_TRANSPORT_NAME_BYTES,
    NEGOTIATION_VERSION,
    NegotiationError,
    type NegotiationErrorCode,
    TRANSPORT_TCP,
    type TransportOffer,
} from "./transport-negotiation";

const VECTOR_TOKEN = "0011223344556677" + "8899aabbccddeeff";

const REQ_TCP_ONLY =
    '{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"tcp","capability_version":1}]}';
const REQ_SHM_TCP =
    '{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"shm","capability_version":1,"parameters":{}},{"transport":"tcp","capability_version":1}]}';
const RESP_TCP_DIRECT =
    '{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"tcp","capability_version":1}}';
const RESP_TCP_FALLBACK =
    '{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"tcp","capability_version":1},"reason":"capability_version_mismatch"}';
const RESP_GRANT =
    `{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"shm","capability_version":1},"activation_token":"${VECTOR_TOKEN}","descriptor":{}}`;
const ACTIVATE_REQ =
    `{"op":"transport.activate","negotiation_version":1,"activation_token":"${VECTOR_TOKEN}"}`;
const ACTIVATE_RESP = '{"op":"transport.activate","negotiation_version":1}';
const COMMIT_REQ = '{"op":"transport.commit","negotiation_version":1}';
const COMMIT_RESP = '{"op":"transport.commit","negotiation_version":1}';

function bytes(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

function text(encoded: Uint8Array): string {
    return new TextDecoder().decode(encoded);
}

function tcpOffer(capabilityVersion: number): TransportOffer {
    return { transport: TRANSPORT_TCP, capabilityVersion };
}

function shmOffer(capabilityVersion: number): TransportOffer {
    return { transport: "shm", capabilityVersion };
}

function expectCode(fn: () => unknown, code: NegotiationErrorCode): NegotiationError {
    let caught: unknown;
    try {
        fn();
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(NegotiationError);
    expect((caught as NegotiationError).code).toBe(code);
    return caught as NegotiationError;
}

describe("tcp-only round trip", () => {
    test("pinned request decodes and re-encodes byte-identically", () => {
        const request = decodeNegotiateRequest(bytes(REQ_TCP_ONLY));
        expect(request.negotiationVersion).toBe(NEGOTIATION_VERSION);
        expect(request.offers).toEqual([{ transport: "tcp", capabilityVersion: 1 }]);
        expect(text(encodeNegotiateRequest(request))).toBe(REQ_TCP_ONLY);
    });

    test("pinned direct selection carries no reason and re-encodes exactly", () => {
        const offers = [tcpOffer(1)];
        const response = decodeNegotiateResponse(bytes(RESP_TCP_DIRECT), offers);
        expect(response.kind).toBe("tcp");
        if (response.kind === "tcp") {
            expect(response.selected).toEqual({ transport: "tcp", capabilityVersion: 1 });
            expect(response.reason).toBeUndefined();
        }
        expect(text(encodeNegotiateResponse(response))).toBe(RESP_TCP_DIRECT);
    });
});

describe("ordered offers and exact selection", () => {
    test("shm+tcp offers preserve client order and opaque parameters", () => {
        const request = decodeNegotiateRequest(bytes(REQ_SHM_TCP));
        expect(request.offers.map((offer) => offer.transport)).toEqual(["shm", "tcp"]);
        expect(request.offers[0]?.parameters).toEqual({});
        expect(text(encodeNegotiateRequest(request))).toBe(REQ_SHM_TCP);
    });

    test("a grant names the exact offered entry and re-encodes exactly", () => {
        const offers = [shmOffer(1), tcpOffer(1)];
        const response = decodeNegotiateResponse(bytes(RESP_GRANT), offers);
        expect(response.kind).toBe("grant");
        if (response.kind === "grant") {
            expect(response.selected).toEqual({ transport: "shm", capabilityVersion: 1 });
            expect(response.activationToken).toBe(VECTOR_TOKEN);
            expect(response.descriptor).toEqual({});
        }
        expect(text(encodeNegotiateResponse(response))).toBe(RESP_GRANT);
    });
});

describe("fallback reasons", () => {
    test("the pinned capability mismatch fallback round-trips", () => {
        const offers = [shmOffer(1), tcpOffer(1)];
        const response = decodeNegotiateResponse(bytes(RESP_TCP_FALLBACK), offers);
        expect(response.kind).toBe("tcp");
        if (response.kind === "tcp") {
            expect(response.reason).toBe("capability_version_mismatch");
        }
        expect(text(encodeNegotiateResponse(response))).toBe(RESP_TCP_FALLBACK);
    });

    test("the closed table decodes; anything else is rejected", () => {
        const offers = [tcpOffer(1)];
        for (const reason of FALLBACK_REASONS) {
            const body = `{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"tcp","capability_version":1},"reason":"${reason}"}`;
            const response = decodeNegotiateResponse(bytes(body), offers);
            if (response.kind === "tcp") expect(response.reason).toBe(reason);
        }
        for (const rejected of ["switching_transports", "connection_in_use"]) {
            const body = `{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"tcp","capability_version":1},"reason":"${rejected}"}`;
            expectCode(() => decodeNegotiateResponse(bytes(body), offers), "invalid_reason");
        }
    });
});

describe("version bounds", () => {
    function requestWithVersion(version: string): string {
        return `{"op":"transport.negotiate","negotiation_version":${version},"offers":[{"transport":"tcp","capability_version":${version}}]}`;
    }

    test("1 and u32::MAX pass", () => {
        for (const version of ["1", "4294967295"]) {
            const request = decodeNegotiateRequest(bytes(requestWithVersion(version)));
            expect(String(request.negotiationVersion)).toBe(version);
            expect(String(request.offers[0]?.capabilityVersion)).toBe(version);
        }
    });

    test("zero, fractions, exponents, negatives, and over-u32 fail", () => {
        for (const version of ["0", "1.5", "1.0", "1e2", "-1", "4294967296"]) {
            expectCode(
                () => decodeNegotiateRequest(bytes(requestWithVersion(version))),
                "invalid_version",
            );
        }
        for (const version of ['"1"', "null"]) {
            expectCode(
                () => decodeNegotiateRequest(bytes(requestWithVersion(version))),
                "invalid_type",
            );
        }
    });

    test("an unsupported request version decodes; a response version other than 1 is rejected", () => {
        const request = decodeNegotiateRequest(
            bytes(
                '{"op":"transport.negotiate","negotiation_version":2,"offers":[{"transport":"tcp","capability_version":1}]}',
            ),
        );
        expect(request.negotiationVersion).toBe(2);
        const respV2 =
            '{"op":"transport.negotiate","negotiation_version":2,"selected":{"transport":"tcp","capability_version":1}}';
        expectCode(() => decodeNegotiateResponse(bytes(respV2), [tcpOffer(1)]), "invalid_version");
    });
});

describe("transport name bounds", () => {
    function requestWithTransport(name: string): string {
        return `{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"${name}","capability_version":1},{"transport":"tcp","capability_version":1}]}`;
    }

    test("1-byte and 32-byte names pass", () => {
        const maxName = `a${"b".repeat(MAX_TRANSPORT_NAME_BYTES - 1)}`;
        for (const name of ["a", maxName, "shm", "io.x2_a-b"]) {
            const request = decodeNegotiateRequest(bytes(requestWithTransport(name)));
            expect(request.offers[0]?.transport).toBe(name);
        }
    });

    test("uppercase, non-ASCII, punctuation, empty, and 33-byte names fail", () => {
        const tooLong = `a${"b".repeat(MAX_TRANSPORT_NAME_BYTES)}`;
        for (const name of [
            "",
            "A",
            "shM",
            "café",
            "sh m",
            "sh+m",
            "1shm",
            ".shm",
            "-shm",
            "_shm",
            tooLong,
        ]) {
            expectCode(
                () => decodeNegotiateRequest(bytes(requestWithTransport(name))),
                "invalid_transport_name",
            );
        }
    });
});

describe("recursive duplicate-key rejection", () => {
    test("duplicates at the root, in offers, and inside opaque values fail before typed decode", () => {
        const root =
            '{"op":"transport.negotiate","op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"tcp","capability_version":1}]}';
        const offer =
            '{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"tcp","transport":"tcp","capability_version":1}]}';
        const duplicateInParametersWithBadVersion =
            '{"op":"transport.negotiate","negotiation_version":0,"offers":[{"transport":"tcp","capability_version":1,"parameters":{"nested":{"k":1,"k":2}}}]}';
        for (const body of [root, offer, duplicateInParametersWithBadVersion]) {
            expectCode(() => decodeNegotiateRequest(bytes(body)), "malformed_json");
        }

        const descriptor =
            `{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"shm","capability_version":1},"activation_token":"${VECTOR_TOKEN}","descriptor":{"a":{"k":1,"k":2}}}`;
        expectCode(
            () => decodeNegotiateResponse(bytes(descriptor), [shmOffer(1), tcpOffer(1)]),
            "malformed_json",
        );
    });
});

describe("offer list bounds", () => {
    test("duplicate identities are rejected; distinct versions of one transport pass", () => {
        const duplicate =
            '{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"tcp","capability_version":1},{"transport":"tcp","capability_version":1}]}';
        expectCode(() => decodeNegotiateRequest(bytes(duplicate)), "duplicate_offer");
        const twoVersions =
            '{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"tcp","capability_version":1},{"transport":"tcp","capability_version":2}]}';
        expect(decodeNegotiateRequest(bytes(twoVersions)).offers).toHaveLength(2);
    });

    test("a missing tcp offer is rejected", () => {
        const noTcp =
            '{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"shm","capability_version":1}]}';
        expectCode(() => decodeNegotiateRequest(bytes(noTcp)), "missing_tcp_offer");
    });

    test("exactly 8 offers pass; 0 and 9 fail", () => {
        function offersBody(count: number): string {
            const offers: string[] = [];
            for (let i = 1; i < count; i++) {
                offers.push(`{"transport":"t${i}","capability_version":1}`);
            }
            offers.push('{"transport":"tcp","capability_version":1}');
            return `{"op":"transport.negotiate","negotiation_version":1,"offers":[${offers.join(",")}]}`;
        }
        expect(decodeNegotiateRequest(bytes(offersBody(MAX_OFFERS))).offers).toHaveLength(
            MAX_OFFERS,
        );
        expectCode(
            () => decodeNegotiateRequest(bytes(offersBody(MAX_OFFERS + 1))),
            "invalid_offer_count",
        );
        const empty = '{"op":"transport.negotiate","negotiation_version":1,"offers":[]}';
        expectCode(() => decodeNegotiateRequest(bytes(empty)), "invalid_offer_count");
    });
});

describe("opaque value bounds", () => {
    function requestWithParameters(parameters: string): string {
        return `{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"tcp","capability_version":1,"parameters":${parameters}}]}`;
    }
    function nestedObjects(depth: number): string {
        let value = "{}";
        for (let level = 1; level < depth; level++) {
            value = `{"n":${value}}`;
        }
        return value;
    }

    test("depth 8 passes; depth 9 fails", () => {
        decodeNegotiateRequest(bytes(requestWithParameters(nestedObjects(MAX_OPAQUE_DEPTH))));
        expectCode(
            () =>
                decodeNegotiateRequest(
                    bytes(requestWithParameters(nestedObjects(MAX_OPAQUE_DEPTH + 1))),
                ),
            "opaque_too_deep",
        );
        // A scalar in the deepest container adds no level (§7.1 counting).
        const scalarLeaf = nestedObjects(MAX_OPAQUE_DEPTH).replace("{}", '{"v":1}');
        decodeNegotiateRequest(bytes(requestWithParameters(scalarLeaf)));
    });

    test("compact 8 KiB passes; one more byte fails", () => {
        const atCap = `{"p":"${"x".repeat(MAX_OPAQUE_BYTES - 8)}"}`;
        expect(atCap.length).toBe(MAX_OPAQUE_BYTES);
        decodeNegotiateRequest(bytes(requestWithParameters(atCap)));
        const overCap = `{"p":"${"x".repeat(MAX_OPAQUE_BYTES - 7)}"}`;
        expectCode(
            () => decodeNegotiateRequest(bytes(requestWithParameters(overCap))),
            "opaque_too_large",
        );
    });

    test("opaque values must be JSON objects", () => {
        for (const parameters of ["[]", "1", '"x"', "null", "true"]) {
            expectCode(
                () => decodeNegotiateRequest(bytes(requestWithParameters(parameters))),
                "invalid_type",
            );
        }
    });

    test("opaque integers beyond the double-safe range are rejected", () => {
        expectCode(
            () => decodeNegotiateRequest(bytes(requestWithParameters('{"id":9007199254740993}'))),
            "invalid_type",
        );
        // The largest double-safe integer still round-trips.
        decodeNegotiateRequest(bytes(requestWithParameters('{"id":9007199254740991}')));
    });

    test("an own __proto__ key stays an own data property", () => {
        // Assigning "__proto__" onto a normal object invokes the prototype
        // setter: the subtree would vanish from JSON.stringify (bypassing
        // the size bound) and mutate the object handed to the provider.
        const request = decodeNegotiateRequest(
            bytes(requestWithParameters('{"__proto__":{"polluted":true},"x":1}')),
        );
        const parameters = request.offers[0]?.parameters as Record<string, unknown>;
        expect(Object.hasOwn(parameters, "__proto__")).toBe(true);
        expect(JSON.stringify(parameters)).toBe('{"__proto__":{"polluted":true},"x":1}');
        expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    });

    test("the same bounds govern a grant descriptor", () => {
        function grantWithDescriptor(descriptor: string): string {
            return `{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"shm","capability_version":1},"activation_token":"${VECTOR_TOKEN}","descriptor":${descriptor}}`;
        }
        const offers = [shmOffer(1), tcpOffer(1)];
        decodeNegotiateResponse(
            bytes(grantWithDescriptor(nestedObjects(MAX_OPAQUE_DEPTH))),
            offers,
        );
        expectCode(
            () =>
                decodeNegotiateResponse(
                    bytes(grantWithDescriptor(nestedObjects(MAX_OPAQUE_DEPTH + 1))),
                    offers,
                ),
            "opaque_too_deep",
        );
        const overCap = `{"p":"${"x".repeat(MAX_OPAQUE_BYTES - 7)}"}`;
        expectCode(
            () => decodeNegotiateResponse(bytes(grantWithDescriptor(overCap)), offers),
            "opaque_too_large",
        );
    });
});

describe("grant and tcp field mixes", () => {
    const offers = [shmOffer(1), tcpOffer(1)];

    test("a non-tcp grant requires both descriptor and activation_token", () => {
        const noToken =
            '{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"shm","capability_version":1},"descriptor":{}}';
        expectCode(() => decodeNegotiateResponse(bytes(noToken), offers), "missing_field");
        const noDescriptor =
            `{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"shm","capability_version":1},"activation_token":"${VECTOR_TOKEN}"}`;
        expectCode(() => decodeNegotiateResponse(bytes(noDescriptor), offers), "missing_field");
    });

    test("a tcp selection carrying either grant field is rejected", () => {
        const withToken =
            `{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"tcp","capability_version":1},"activation_token":"${VECTOR_TOKEN}"}`;
        expectCode(() => decodeNegotiateResponse(bytes(withToken), offers), "unexpected_field");
        const withDescriptor =
            '{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"tcp","capability_version":1},"descriptor":{}}';
        expectCode(
            () => decodeNegotiateResponse(bytes(withDescriptor), offers),
            "unexpected_field",
        );
    });

    test("a grant carrying a fallback reason is rejected", () => {
        const grantWithReason =
            `{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"shm","capability_version":1},"activation_token":"${VECTOR_TOKEN}","descriptor":{},"reason":"unavailable"}`;
        expectCode(
            () => decodeNegotiateResponse(bytes(grantWithReason), offers),
            "unexpected_field",
        );
    });

    test("field sets are closed: unknown fields are malformed", () => {
        const unknownField =
            '{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"tcp","capability_version":1}],"future":1}';
        expectCode(() => decodeNegotiateRequest(bytes(unknownField)), "unexpected_field");
        const unknownOfferField =
            '{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"tcp","capability_version":1,"extra":1}]}';
        expectCode(() => decodeNegotiateRequest(bytes(unknownOfferField)), "unexpected_field");
    });
});

describe("unoffered selections", () => {
    const offers = [shmOffer(1), tcpOffer(1)];

    test("an unoffered transport is rejected", () => {
        const wrongTransport =
            '{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"uds","capability_version":1}}';
        expectCode(
            () => decodeNegotiateResponse(bytes(wrongTransport), offers),
            "unoffered_selection",
        );
    });

    test("an offered transport at an unoffered capability version is rejected", () => {
        const wrongVersion =
            '{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"tcp","capability_version":2}}';
        expectCode(
            () => decodeNegotiateResponse(bytes(wrongVersion), offers),
            "unoffered_selection",
        );
    });
});

describe("activation and commit", () => {
    test("correlations are fixed: activate 1, commit 2, application from 3", () => {
        expect(ACTIVATION_CORRELATION).toBe(1n);
        expect(COMMIT_CORRELATION).toBe(2n);
        expect(FIRST_APPLICATION_CORRELATION).toBe(3n);
    });

    test("pinned bodies decode and re-encode byte-identically", () => {
        const activate = decodeActivateRequest(bytes(ACTIVATE_REQ));
        expect(activate.activationToken).toBe(VECTOR_TOKEN);
        expect(text(encodeActivateRequest(activate.activationToken))).toBe(ACTIVATE_REQ);
        decodeActivateResponse(bytes(ACTIVATE_RESP));
        expect(text(activateResponseJson())).toBe(ACTIVATE_RESP);
        decodeCommitRequest(bytes(COMMIT_REQ));
        expect(text(commitRequestJson())).toBe(COMMIT_REQ);
        decodeCommitResponse(bytes(COMMIT_RESP));
        expect(text(commitResponseJson())).toBe(COMMIT_RESP);
    });

    test("tagged responses carry no provider data: extra fields are malformed", () => {
        const paddedResponse =
            '{"op":"transport.activate","negotiation_version":1,"descriptor":{}}';
        expectCode(() => decodeActivateResponse(bytes(paddedResponse)), "unexpected_field");
        const paddedCommit = '{"op":"transport.commit","negotiation_version":1,"note":"x"}';
        expectCode(() => decodeCommitResponse(bytes(paddedCommit)), "unexpected_field");
    });

    test("the token form is exactly 32 lowercase hex characters", () => {
        expect(VECTOR_TOKEN).toHaveLength(ACTIVATION_TOKEN_LEN);
        expect(isValidActivationToken(VECTOR_TOKEN)).toBe(true);
        for (const bad of [
            "00112233445566778899aabbccddeef", // 31
            "00112233445566778899aabbccddeeff0", // 33
            "00112233445566778899AABBCCDDEEFF", // uppercase
            "00112233445566778899aabbccddeegg", // non-hex
            "",
        ]) {
            expect(isValidActivationToken(bad)).toBe(false);
            const body = `{"op":"transport.activate","negotiation_version":1,"activation_token":"${bad}"}`;
            expectCode(() => decodeActivateRequest(bytes(body)), "invalid_activation_token");
        }
    });

    test("wrong operation tags and versions are rejected on the candidate path", () => {
        expectCode(() => decodeActivateRequest(bytes(COMMIT_REQ)), "wrong_operation");
        const v2Commit = '{"op":"transport.commit","negotiation_version":2}';
        expectCode(() => decodeCommitRequest(bytes(v2Commit)), "invalid_version");
    });
});

describe("error hygiene", () => {
    const SENTINEL = "SENTINEL-PROVIDER-SECRET";

    test("failures expose a bounded code and structural path without provider bytes", () => {
        const tooDeep = `{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"tcp","capability_version":1,"parameters":{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":{"i":"${SENTINEL}"}}}}}}}}}}]}`;
        const error = expectCode(() => decodeNegotiateRequest(bytes(tooDeep)), "opaque_too_deep");
        expect(error.path).toBe("offers[0].parameters");
        expect(error.message).not.toContain(SENTINEL);
        expect(error.stack ?? "").not.toContain(SENTINEL);
    });

    test("a hostile unknown key is not echoed into the error path", () => {
        const hostileKey = `{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"tcp","capability_version":1}],"${SENTINEL}":1}`;
        const error = expectCode(
            () => decodeNegotiateRequest(bytes(hostileKey)),
            "unexpected_field",
        );
        expect(error.path).toBe("body");
        expect(error.message).not.toContain(SENTINEL);
    });
});

describe("encode-side validation", () => {
    test("encoders refuse out-of-contract values", () => {
        expectCode(
            () =>
                encodeNegotiateRequest({
                    negotiationVersion: NEGOTIATION_VERSION,
                    offers: [shmOffer(1)],
                }),
            "missing_tcp_offer",
        );
        const tooMany: TransportOffer[] = [];
        for (let i = 0; i < MAX_OFFERS; i++) {
            tooMany.push({ transport: `t${i}`, capabilityVersion: 1 });
        }
        tooMany.push(tcpOffer(1));
        expectCode(
            () =>
                encodeNegotiateRequest({
                    negotiationVersion: NEGOTIATION_VERSION,
                    offers: tooMany,
                }),
            "invalid_offer_count",
        );
        expectCode(
            () =>
                encodeNegotiateRequest({
                    negotiationVersion: NEGOTIATION_VERSION,
                    offers: [{ transport: "SHM", capabilityVersion: 1 }, tcpOffer(1)],
                }),
            "invalid_transport_name",
        );
        expectCode(
            () =>
                encodeNegotiateRequest({
                    negotiationVersion: 1.5,
                    offers: [tcpOffer(1)],
                }),
            "invalid_version",
        );
        expectCode(
            () =>
                encodeNegotiateResponse({
                    kind: "grant",
                    selected: { transport: TRANSPORT_TCP, capabilityVersion: 1 },
                    activationToken: VECTOR_TOKEN,
                    descriptor: {},
                }),
            "invalid_transport_name",
        );
        expectCode(() => encodeActivateRequest("not-a-token"), "invalid_activation_token");
    });

    test("provider-supplied opaque values are bounded before they reach the wire", () => {
        function offersWith(parameters: unknown): TransportOffer[] {
            return [
                { transport: "shm", capabilityVersion: 1, parameters } as TransportOffer,
                tcpOffer(1),
            ];
        }
        const encode = (parameters: unknown) =>
            encodeNegotiateRequest({
                negotiationVersion: NEGOTIATION_VERSION,
                offers: offersWith(parameters),
            });
        // The decoder's exact bounds apply on the way out too.
        expectCode(() => encode({ x: "x".repeat(9000) }), "opaque_too_large");
        let deep: Record<string, unknown> = {};
        for (let level = 0; level < MAX_OPAQUE_DEPTH; level++) {
            deep = { n: deep };
        }
        expectCode(() => encode(deep), "opaque_too_deep");
        for (const parameters of [[], 1, "x", null, true]) {
            expectCode(() => encode(parameters), "invalid_type");
        }
        // JavaScript-only shapes are judged by their serialized form: a
        // Date or a custom toJSON reaches the wire as whatever it
        // serializes to, not as the nominal object.
        expectCode(() => encode(new Date(0)), "invalid_type");
        expectCode(() => encode({ toJSON: () => "not-an-object" }), "invalid_type");
        // A toJSON yielding undefined is an invalid opaque value, not an
        // absent one.
        expectCode(() => encode({ toJSON: () => undefined }), "invalid_type");
        // Lone surrogates survive JSON.stringify as escapes but the host's
        // strict UTF-8 decoder rejects them; fail locally instead.
        expectCode(() => encode({ s: "\uD800" }), "invalid_type");
        expectCode(() => encode({ "\uDC00": 1 }), "invalid_type");
        // Integral numbers beyond the double-safe range are already rounded,
        // so the advertised identifier is not the one the caller meant.
        const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
        expectCode(() => encode({ id: unsafeInteger }), "invalid_type");
        expectCode(() => encode({ nested: [{ id: unsafeInteger }] }), "invalid_type");
        // The largest safe integer still encodes.
        encode({ id: Number.MAX_SAFE_INTEGER });
        const error = expectCode(
            () =>
                encodeNegotiateResponse({
                    kind: "grant",
                    selected: { transport: "shm", capabilityVersion: 1 },
                    activationToken: VECTOR_TOKEN,
                    descriptor: { x: "x".repeat(9000) },
                }),
            "opaque_too_large",
        );
        expect(error.path).toBe("descriptor");
    });

    test("a stateful toJSON cannot emit a different shape than was validated", () => {
        // checkOpaquePlain serializes once and the validated snapshot is
        // what reaches the wire, so the second toJSON result never exists.
        let calls = 0;
        const sneaky = {
            toJSON: () => {
                calls += 1;
                return calls === 1 ? { ok: true } : "bad";
            },
        };
        const encoded = encodeNegotiateRequest({
            negotiationVersion: NEGOTIATION_VERSION,
            offers: [
                { transport: "shm", capabilityVersion: 1, parameters: sneaky } as TransportOffer,
                tcpOffer(1),
            ],
        });
        const decoded = decodeNegotiateRequest(encoded);
        expect(decoded.offers[0]?.parameters).toEqual({ ok: true });
    });
});
