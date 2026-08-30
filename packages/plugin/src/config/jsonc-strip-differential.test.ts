import { describe, expect, it } from "bun:test";
import { stripJsonComments, stripTrailingCommas } from "../shared/jsonc-parser";

/**
 * Verbatim copy of the scanner `normalizedJsoncSemantics` used before it moved
 * onto the shared jsonc-parser strip pipeline. Kept as the reference oracle so
 * the migration comparator's refuse-and-warn gate cannot silently become more
 * or less permissive than the behavior these cases pin.
 */
function referenceStripJsoncForParse(input: string): string {
    let out = "";
    let inString = false;
    let escaped = false;
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        const next = input[i + 1];
        if (inString) {
            out += ch;
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }
        if (ch === "/" && next === "/") {
            while (i < input.length && input[i] !== "\n") i++;
            out += "\n";
            continue;
        }
        if (ch === "/" && next === "*") {
            i += 2;
            while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
            i++;
            out += " ";
            continue;
        }
        out += ch;
    }
    let withoutTrailingCommas = "";
    inString = false;
    escaped = false;
    for (let i = 0; i < out.length; i++) {
        const ch = out[i];
        if (inString) {
            withoutTrailingCommas += ch;
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            withoutTrailingCommas += ch;
            continue;
        }
        if (ch === ",") {
            let j = i + 1;
            while (j < out.length && /\s/.test(out[j])) j++;
            if (out[j] === "}" || out[j] === "]") continue;
        }
        withoutTrailingCommas += ch;
    }
    return withoutTrailingCommas;
}

type ParseOutcome = { ok: true; value: unknown } | { ok: false };

function parseVia(strip: (input: string) => string, content: string): ParseOutcome {
    try {
        return { ok: true, value: JSON.parse(strip(content)) };
    } catch {
        return { ok: false };
    }
}

const CORPUS: string[] = [
    "{}",
    '{"a":1}',
    '{"a": 1, "b": [1, 2, 3],}',
    '{"a": {"b": {"c": true,},},}',
    "[1, 2, 3,]",
    `{
        // line comment
        "memory": { "enabled": true }, // trailing line comment
        /* block
           comment */
        "embedding": { "provider": "synapse" },
    }`,
    '{"a": 1} // comment at EOF without newline',
    '{"a": 1} /* unterminated block comment',
    '{"url": "https://example.com/path", "glob": "src/**/*.ts"}',
    '{"s": "not // a comment", "t": "not /* a comment */"}',
    '{"esc": "quote \\" backslash \\\\ slash \\/ newline \\n"}',
    '{"unicode": "\\u00e9\\u2028\\u2029", "emoji": "🙂"}',
    '{"deep": [{"a": [],}, {"b": {},},],}',
    '{"empty_string": "", "null": null, "num": -1.5e3}',
    '  \n\t {"leading": "whitespace"}  \n',
    '{"comma_in_string": "a,}", "bracket_in_string": "]"}',
    "",
    "not json at all",
    '{"a": 1,, }',
    "// only a comment",
];

describe("migration comparator strip pipeline", () => {
    it("parses every corpus case identically to the pre-consolidation scanner", () => {
        for (const content of CORPUS) {
            const reference = parseVia(referenceStripJsoncForParse, content);
            const shared = parseVia(
                (input) => stripTrailingCommas(stripJsonComments(input)),
                content,
            );
            expect(shared).toEqual(reference);
        }
    });
});
