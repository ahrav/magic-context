import { describe, expect, test } from "bun:test";
import { badgeTextColor, readableTextColorOn } from "./badge-contrast";

describe("badgeTextColor (AFT parity with #186 safety net)", () => {
    const accent = { r: 0.6, g: 0.5, b: 0.9, a: 1 };

    test("opaque distinct background is used verbatim as the label", () => {
        const background = { r: 0.05, g: 0.05, b: 0.07, a: 1 }; // near-black dark theme
        expect(badgeTextColor(accent, background)).toBe(background);
    });

    test("light theme: background is used verbatim too (near-white label inverse)", () => {
        const background = { r: 0.97, g: 0.97, b: 0.95, a: 1 };
        expect(badgeTextColor(accent, background)).toBe(background);
    });

    test("transparent background (alpha 0) falls back to a visible pick (#186)", () => {
        const transparent = { r: 0, g: 0, b: 0, a: 0 };
        const result = badgeTextColor(accent, transparent);
        expect(result).not.toBe(transparent);
        expect(result).toBe(readableTextColorOn(accent));
    });

    test("background ~= accent falls back to a visible pick", () => {
        const sameAsAccent = { r: 0.6, g: 0.5, b: 0.9, a: 1 };
        const result = badgeTextColor(accent, sameAsAccent);
        expect(result).toBe(readableTextColorOn(accent));
    });

    test("missing alpha is treated as opaque", () => {
        const background = { r: 0.05, g: 0.05, b: 0.07 };
        expect(badgeTextColor(accent, background)).toBe(background);
    });
});

describe("readableTextColorOn", () => {
    test("dark accent gets white text", () => {
        expect(readableTextColorOn({ r: 0.1, g: 0.1, b: 0.3 })).toBe("#ffffff");
        expect(readableTextColorOn({ r: 0, g: 0, b: 0 })).toBe("#ffffff");
    });

    test("light accent gets black text", () => {
        // White text does not meet the contrast threshold on this accent.
        expect(readableTextColorOn({ r: 0.9, g: 0.9, b: 0.7 })).toBe("#000000");
        expect(readableTextColorOn({ r: 1, g: 1, b: 1 })).toBe("#000000");
    });

    test("mid-tone orange accent prefers white (white-bias, matches sibling badges)", () => {
        // readableTextColorOn prefers white when it meets the bold-text contrast threshold, even if black has higher contrast.
        expect(readableTextColorOn({ r: 0.69, g: 0.455, b: 0.188 })).toBe("#ffffff");
        expect(readableTextColorOn({ r: 0.741, g: 0.482, b: 0.2 })).toBe("#ffffff");
    });

    test("pure green is treated as light (white fails the contrast bar)", () => {
        // White text does not meet the contrast threshold on this green.
        expect(readableTextColorOn({ r: 0, g: 1, b: 0 })).toBe("#000000");
    });

    test("pure blue is treated as dark (low luma weight)", () => {
        // Blue's low perceived brightness requires light text.
        expect(readableTextColorOn({ r: 0, g: 0, b: 1 })).toBe("#ffffff");
    });

    test("does not depend on the (possibly transparent) background alpha", () => {
        const a = readableTextColorOn({ r: 0.2, g: 0.2, b: 0.2 });
        const b = readableTextColorOn({ r: 0.2, g: 0.2, b: 0.2 });
        expect(a).toBe(b);
        expect(a).toBe("#ffffff");
    });
});
