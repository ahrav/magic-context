import { describe, expect, it } from "bun:test";
import { formatAge } from "./format-age";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function agoDays(days: number): number {
    return Date.now() - days * MS_PER_DAY;
}

describe("formatAge", () => {
    it("covers each vocabulary band", () => {
        expect(formatAge(Date.now() + MS_PER_DAY)).toBe("future");
        expect(formatAge(agoDays(0))).toBe("today");
        expect(formatAge(agoDays(1))).toBe("1d ago");
        expect(formatAge(agoDays(29))).toBe("29d ago");
        expect(formatAge(agoDays(30))).toBe("1mo ago");
        expect(formatAge(agoDays(60))).toBe("2mo ago");
        expect(formatAge(agoDays(365))).toBe("1y ago");
        expect(formatAge(agoDays(730))).toBe("2y ago");
    });

    it("stays in months for the 360-364 day range", () => {
        // months === 12 here, but the year does not start until day 365.
        expect(formatAge(agoDays(360))).toBe("12mo ago");
        expect(formatAge(agoDays(364))).toBe("12mo ago");
    });
});
