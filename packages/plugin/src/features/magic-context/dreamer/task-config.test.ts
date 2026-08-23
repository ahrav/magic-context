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

    test("without an override the dreamer default leads and historian settings never appear", () => {
        const historian = {
            model: "historian/primary",
            module_model: "historian/module",
            fallback_models: ["historian/fallback"],
        };
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
        for (const historianModel of [
            historian.model,
            historian.module_model,
            ...historian.fallback_models,
        ]) {
            expect(chain).not.toContain(historianModel);
        }
    });

    test("drops non-canonical entries and yields an empty chain when nothing is configured", () => {
        expect(buildClassifyModelChain(undefined, undefined, undefined)).toEqual([]);
        expect(buildClassifyModelChain("flat-model", "/model", ["prov/", " "])).toEqual([]);
    });
});
