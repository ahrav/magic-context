import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { MagicContextConfigSchema } from "../config/schema/magic-context";
import { resolveEmbeddingRouting } from "./embedding-routing";

describe("embedding routing", () => {
    it("keeps configured Synapse as deferred intent without discovery", async () => {
        const config = MagicContextConfigSchema.parse({
            embedding: { provider: "synapse", fallback_provider: "local" },
            subc: { connection_file: "~/run/subc.json" },
        });
        const routing = await resolveEmbeddingRouting({
            config,
            projectRoot: "/repo",
            session: "ses-routing",
        });
        expect(routing.primary).toMatchObject({
            provider: "synapse",
            synapse_connection_origin: "explicit",
            synapse_connection_file: `${homedir()}/run/subc.json`,
        });
        expect(routing.primary).not.toHaveProperty("synapse_fingerprint");
        expect(routing.warnings).toEqual([]);
        const { subc } = config;
        expect(subc?.connection_file).toBe(`${homedir()}/run/subc.json`);
    });

    it("uses managed-default provenance when Synapse has no transport block", async () => {
        const config = MagicContextConfigSchema.parse({
            embedding: { provider: "synapse", fallback_provider: "off" },
        });
        const routing = await resolveEmbeddingRouting({ config, projectRoot: "/repo" });
        expect(routing.primary).toMatchObject({
            provider: "synapse",
            synapse_connection_origin: "managed-default",
        });
        expect(routing.primary).not.toHaveProperty("synapse_connection_file");
        expect(routing.primary).not.toHaveProperty("synapse_fingerprint");
        expect(routing.shadow).toBeNull();
        expect(routing.warnings).toEqual([]);
    });
});
