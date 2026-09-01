/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { CANONICAL_DREAM_TASKS, isCanonicalDreamTask, MEMORY_DOMAIN_TASKS } from "./task-registry";

describe("dreamer task registry", () => {
    test("classify-memories is canonical, memory-domain, and ordered after curate", () => {
        expect(isCanonicalDreamTask("classify-memories")).toBe(true);
        expect(isCanonicalDreamTask("retrospective")).toBe(true);
        expect(MEMORY_DOMAIN_TASKS).toEqual([
            "map-memories",
            "verify",
            "verify-broad",
            "curate",
            "compress-cues",
            "classify-memories",
            "retrospective",
            "promote-primers",
            "refresh-primers",
        ]);
        expect(CANONICAL_DREAM_TASKS.indexOf("map-memories")).toBe(0);
        expect(CANONICAL_DREAM_TASKS.indexOf("compress-cues")).toBe(
            CANONICAL_DREAM_TASKS.indexOf("curate") + 1,
        );
        expect(CANONICAL_DREAM_TASKS.indexOf("classify-memories")).toBe(
            CANONICAL_DREAM_TASKS.indexOf("compress-cues") + 1,
        );
        expect(CANONICAL_DREAM_TASKS.indexOf("retrospective")).toBe(
            CANONICAL_DREAM_TASKS.indexOf("classify-memories") + 1,
        );
    });
});
