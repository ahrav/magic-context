import { describe, expect, test } from "bun:test";
import {
    type ImitatedArgRule,
    type ImitatedArgsSchema,
    unwrapImitatedReducedArgs,
} from "./unwrap-imitated-reduced-args";

const cases: Array<{
    name: string;
    primary: string[];
    schema: ImitatedArgsSchema;
    valid: Record<string, unknown>;
    wrong: Record<string, unknown>;
}> = [
    {
        name: "memory",
        primary: ["action"],
        schema: {
            action: { type: "enum", values: ["write", "get"] },
            content: "string",
            ids: { type: "array", items: "number", maxItems: 100 },
        },
        valid: { action: "write", content: "fact" },
        wrong: { action: 7 },
    },
    {
        name: "note",
        primary: ["action", "content"],
        schema: {
            action: { type: "enum", values: ["write", "read"] },
            content: "string",
        },
        valid: { content: "follow up" },
        wrong: { content: {} },
    },
    {
        name: "reduce",
        primary: ["drop"],
        schema: { drop: "string" },
        valid: { drop: "1-3" },
        wrong: { drop: [1] },
    },
    {
        name: "search",
        primary: ["query"],
        schema: { query: "string", limit: "number" },
        valid: { query: "needle", limit: 3 },
        wrong: { query: {} },
    },
    {
        name: "expand",
        primary: ["message", "start"],
        schema: { message: "number", start: "number", end: "number" },
        valid: { start: 1, end: 2 },
        wrong: { start: "one", end: 2 },
    },
];

describe("imitated reduced argument revalidation", () => {
    for (const arm of cases) {
        test(`${arm.name} accepts only schema-valid decoded fields`, () => {
            const validOuter = { reduced: true, summary: JSON.stringify(arm.valid) };
            expect(unwrapImitatedReducedArgs(validOuter, arm.primary, arm.schema)).toEqual(
                arm.valid,
            );

            for (const invalid of [
                arm.wrong,
                { ...arm.valid, unknown: true },
                { ...arm.valid, ids: Array.from({ length: 101 }, (_, index) => index) },
                { ...arm.valid, content: "x".repeat(1024 * 1024 + 1) },
            ]) {
                const outer = { reduced: true, summary: JSON.stringify(invalid) };
                expect(() =>
                    unwrapImitatedReducedArgs(outer, arm.primary, arm.schema),
                ).not.toThrow();
                expect(unwrapImitatedReducedArgs(outer, arm.primary, arm.schema)).toBe(outer);
            }
        });

        test(`${arm.name} keeps explicit valid primary fields`, () => {
            const primary = arm.primary[0] ?? "action";
            const outer = {
                [primary]: arm.valid[primary] ?? "explicit",
                reduced: true,
                summary: JSON.stringify(arm.wrong),
            };
            expect(unwrapImitatedReducedArgs(outer, arm.primary, arm.schema)).toBe(outer);
        });
    }
});

// Object-valued fields exist because claim mutations carry a mutation token, whose
// every field the tool consumes. Decode must accept the exact token shape and
// nothing else, since a decoded object bypasses the adapter's own arg schema.
const TOKEN_RULE: ImitatedArgRule = {
    type: "object",
    fields: {
        tokenVersion: "number",
        publicClaimId: "string",
        revision: "number",
        contentDigest: "string",
        lifecycleSeq: "number",
        applicabilityHeadsDigest: "string",
        policyHeadsDigest: "string",
    },
};

const OBJECT_SCHEMA: ImitatedArgsSchema = {
    action: { type: "enum", values: ["revise", "merge"] },
    content: "string",
    mutationToken: TOKEN_RULE,
    mutationTokens: { type: "array", items: TOKEN_RULE, maxItems: 20 },
};

const OBJECT_PRIMARY = ["action"];

function token(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        tokenVersion: 1,
        publicClaimId: `mcm_${"a".repeat(32)}`,
        revision: 2,
        contentDigest: "sha256:content",
        lifecycleSeq: 3,
        applicabilityHeadsDigest: "sha256:applicability",
        policyHeadsDigest: "sha256:policy",
        ...overrides,
    };
}

function tokenWithout(field: string): Record<string, unknown> {
    return Object.fromEntries(Object.entries(token()).filter(([key]) => key !== field));
}

describe("imitated reduced object and nested array fields", () => {
    test("accepts required-only and nullable optional object fields", () => {
        const schema: ImitatedArgsSchema = {
            payload: {
                type: "object",
                fields: { required: "string" },
                optionalFields: { optional: "string" },
            },
        };
        for (const accepted of [
            { payload: { required: "yes" } },
            { payload: { required: "yes", optional: null } },
        ]) {
            const outer = { reduced: true, summary: JSON.stringify(accepted) };
            expect(unwrapImitatedReducedArgs(outer, ["action"], schema)).toEqual(accepted);
        }
    });

    test("rejects prototype-name extras that are not declared own fields", () => {
        const accepted = { action: "revise", mutationToken: token({ toString: "forged" }) };
        const outer = { reduced: true, summary: JSON.stringify(accepted) };
        expect(unwrapImitatedReducedArgs(outer, OBJECT_PRIMARY, OBJECT_SCHEMA)).toBe(outer);
    });

    for (const [name, accepted] of [
        ["single mutation token", { action: "revise", mutationToken: token() }],
        [
            "token plus sibling primitives",
            { action: "revise", mutationToken: token(), content: "revised" },
        ],
        [
            "ordered token array",
            {
                action: "merge",
                mutationTokens: [token(), token({ publicClaimId: `mcm_${"b".repeat(32)}` })],
            },
        ],
        ["empty token array", { action: "merge", mutationTokens: [] }],
        [
            "token array exactly at the cap",
            { action: "merge", mutationTokens: Array.from({ length: 20 }, () => token()) },
        ],
    ] as Array<[string, Record<string, unknown>]>) {
        test(`accepts ${name}`, () => {
            const outer = { reduced: true, summary: JSON.stringify(accepted) };
            expect(unwrapImitatedReducedArgs(outer, OBJECT_PRIMARY, OBJECT_SCHEMA)).toEqual(
                accepted,
            );
        });
    }

    for (const [name, rejected] of [
        [
            "a token missing a field",
            { action: "revise", mutationToken: tokenWithout("policyHeadsDigest") },
        ],
        [
            "a token with an extra field",
            { action: "revise", mutationToken: { ...token(), extra: "x" } },
        ],
        [
            "a token with a wrong-typed field",
            { action: "revise", mutationToken: token({ revision: "2" }) },
        ],
        ["a token as a string", { action: "revise", mutationToken: JSON.stringify(token()) }],
        ["a token as an array", { action: "revise", mutationToken: [token()] }],
        ["a token as null", { action: "revise", mutationToken: null }],
        ["a token as a number", { action: "revise", mutationToken: 1 }],
        [
            "a nested object smuggled into a token string field",
            { action: "revise", mutationToken: token({ contentDigest: { nested: "sha256:x" } }) },
        ],
        [
            "a nested object smuggled in beside the token fields",
            { action: "revise", mutationToken: { ...token(), nested: { tokenVersion: 1 } } },
        ],
        ["an array holding junk", { action: "merge", mutationTokens: [token(), "not-a-token"] }],
        [
            "an array holding a malformed token",
            { action: "merge", mutationTokens: [token(), tokenWithout("revision")] },
        ],
        ["an array holding null", { action: "merge", mutationTokens: [null] }],
        [
            "a token array over the cap",
            { action: "merge", mutationTokens: Array.from({ length: 21 }, () => token()) },
        ],
        ["an object where a primitive is declared", { action: "revise", content: token() }],
        ["an unknown top-level field", { action: "revise", mutationToken: token(), unknown: true }],
        [
            "an oversized string inside a token",
            {
                action: "revise",
                mutationToken: token({ contentDigest: "x".repeat(1024 * 1024 + 1) }),
            },
        ],
    ] as Array<[string, Record<string, unknown>]>) {
        test(`rejects ${name}`, () => {
            const outer = { reduced: true, summary: JSON.stringify(rejected) };
            expect(() =>
                unwrapImitatedReducedArgs(outer, OBJECT_PRIMARY, OBJECT_SCHEMA),
            ).not.toThrow();
            expect(unwrapImitatedReducedArgs(outer, OBJECT_PRIMARY, OBJECT_SCHEMA)).toBe(outer);
        });
    }
});

describe("imitated reduced array item rules", () => {
    const schema: ImitatedArgsSchema = {
        action: { type: "enum", values: ["write"] },
        tags: { type: "array", items: "string", values: ["a", "b"] },
        flags: { type: "array", items: "boolean" },
    };

    test("keeps enum values enforced for string items", () => {
        const valid = { action: "write", tags: ["a", "b"] };
        const validOuter = { reduced: true, summary: JSON.stringify(valid) };
        expect(unwrapImitatedReducedArgs(validOuter, ["action"], schema)).toEqual(valid);

        const outer = { reduced: true, summary: JSON.stringify({ action: "write", tags: ["c"] }) };
        expect(unwrapImitatedReducedArgs(outer, ["action"], schema)).toBe(outer);
    });

    test("applies the default array cap when maxItems is absent", () => {
        const outer = {
            reduced: true,
            summary: JSON.stringify({
                action: "write",
                tags: Array.from({ length: 101 }, () => "a"),
            }),
        };
        expect(unwrapImitatedReducedArgs(outer, ["action"], schema)).toBe(outer);
    });

    test("validates non-primitive item rules through the shared field check", () => {
        const valid = { action: "write", flags: [true, false] };
        const validOuter = { reduced: true, summary: JSON.stringify(valid) };
        expect(unwrapImitatedReducedArgs(validOuter, ["action"], schema)).toEqual(valid);

        const outer = {
            reduced: true,
            summary: JSON.stringify({ action: "write", flags: ["true"] }),
        };
        expect(unwrapImitatedReducedArgs(outer, ["action"], schema)).toBe(outer);
    });
});

describe("imitated reduced optional object fields", () => {
    const rule: ImitatedArgRule = {
        type: "object",
        fields: {
            trigger: "string",
            rejectedStrategy: "string",
            rejectionReason: "string",
        },
        optionalFields: {
            saferAlternative: "string",
            preconditions: "string",
        },
    };
    const schema: ImitatedArgsSchema = {
        action: { type: "enum", values: ["create"] },
        antiMemory: rule,
    };
    const required = {
        trigger: "Choosing a cache backend",
        rejectedStrategy: "Use Redis",
        rejectionReason: "The project must work offline",
    };

    for (const [name, antiMemory] of [
        ["required fields only", required],
        ["a present optional field", { ...required, saferAlternative: "Use SQLite" }],
        ["a null optional field", { ...required, saferAlternative: null }],
        [
            "every declared optional field",
            { ...required, saferAlternative: "Use SQLite", preconditions: null },
        ],
    ] as Array<[string, Record<string, unknown>]>) {
        test(`accepts ${name}`, () => {
            const decoded = { action: "create", antiMemory };
            const outer = { reduced: true, summary: JSON.stringify(decoded) };
            expect(unwrapImitatedReducedArgs(outer, ["action"], schema)).toEqual(decoded);
        });
    }

    for (const [name, antiMemory] of [
        ["a missing required field", { trigger: "t", rejectedStrategy: "r" }],
        ["an undeclared field", { ...required, extra: "x" }],
        ["a wrong-typed optional field", { ...required, saferAlternative: 7 }],
        ["a null required field", { ...required, trigger: null }],
    ] as Array<[string, Record<string, unknown>]>) {
        test(`rejects ${name}`, () => {
            const decoded = { action: "create", antiMemory };
            const outer = { reduced: true, summary: JSON.stringify(decoded) };
            expect(unwrapImitatedReducedArgs(outer, ["action"], schema)).toBe(outer);
        });
    }
});
