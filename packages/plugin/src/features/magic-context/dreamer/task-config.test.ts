/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { DreamerConfigSchema } from "../../../config/schema/magic-context";
import { buildClassifyModelChain, buildDreamTaskRuntimeConfigs } from "./task-config";

describe("buildClassifyModelChain", () => {
    test("task override precedes the dreamer default and duplicates dedupe stably", () => {
        expect(
            buildClassifyModelChain("prov/override", "prov/default", [
                "prov/default",
                "prov/fb-a",
                "prov/override",
                "prov/fb-a",
                "prov/fb-b",
            ]),
        ).toEqual(["prov/override", "prov/default", "prov/fb-a", "prov/fb-b"]);
    });

    test("without an override the dreamer default leads", () => {
        const dreamer = DreamerConfigSchema.parse({
            model: "prov/dream-default",
            fallback_models: ["prov/fb"],
        });
        const classify = buildDreamTaskRuntimeConfigs(dreamer).find(
            (t) => t.task === "classify-memories",
        );
        const chain = buildClassifyModelChain(
            classify?.model,
            dreamer.model,
            classify?.fallbackModels,
        );
        expect(chain).toEqual(["prov/dream-default", "prov/fb"]);
        // Historian-model exclusion is asserted by the Rust decoder test `dreamer_run_task_uses_request_chain_and_route_harness` (crates/mc-module/src/lib.rs), where the poisoned chain reaches real production code; a local historian object here does not. commentlint: allow(JUDGE)
    });

    test("drops non-canonical entries and yields an empty chain when nothing is configured", () => {
        expect(buildClassifyModelChain(undefined, undefined, undefined)).toEqual([]);
        expect(buildClassifyModelChain("flat-model", "/model", ["prov/", " "])).toEqual([]);
    });
});
