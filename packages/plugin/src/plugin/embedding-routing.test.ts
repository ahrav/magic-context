import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { MagicContextConfigSchema } from "../config/schema/magic-context";
import { resolveEmbeddingRouting } from "./embedding-routing";

describe("embedding routing", () => {
    it("keeps Synapse transport settings out of the resolved fallback config", async () => {
        const config = MagicContextConfigSchema.parse({
            embedding: { provider: "synapse", fallback_provider: "local" },
            subc: { connection_file: "~/run/subc.json" },
        });
        const routing = await resolveEmbeddingRouting({
            config,
            projectRoot: "/repo",
            session: "ses-routing",
        });
        expect(routing.primary).toEqual({
            provider: "local",
            model: "Xenova/bge-small-en-v1.5",
        });
        expect(routing.primary).not.toHaveProperty("fallback_provider");
        expect(config.subc?.connection_file).toBe(`${homedir()}/run/subc.json`);
        expect(routing.warnings.some((warning) => warning.includes("Synapse"))).toBe(true);
    });

    it("warns and falls back when Synapse has no transport block", async () => {
        const config = MagicContextConfigSchema.parse({
            embedding: { provider: "synapse", fallback_provider: "off" },
        });
        const routing = await resolveEmbeddingRouting({ config, projectRoot: "/repo" });
        expect(routing.primary).toEqual({ provider: "off" });
        expect(routing.shadow).toBeNull();
        expect(routing.warnings.join(" ")).toContain("subc");
    });
});
