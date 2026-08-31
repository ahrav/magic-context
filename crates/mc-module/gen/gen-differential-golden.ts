/**
 *
 */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

const generatorVersion = "dg-reference-v1";
const textMessage = (role: string, text: string) => ({
  role,
  content: [{ kind: { type: "text", text } }],
  meta: {},
});
const scenarios = [
  {
    id: "DG-1-bust-veto",
    family: "postprocess-gates",
    input: { session_id: "dg-session", markers: ["bust", "veto"], messages: [textMessage("user", "stable input")] },
    output: { status: "ok", action: "passthrough", decision: "defer" },
  },
  {
    id: "DG-2-marker-representation",
    family: "marker-representation",
    input: { session_id: "dg-session", markers: ["<system-reminder>", "[dropped 2]"], messages: [textMessage("assistant", "kept tail")] },
    output: { status: "ok", action: "passthrough", decision: "replay" },
  },
  {
    id: "DG-3-escalation-band",
    family: "escalation-bands",
    input: { session_id: "dg-session", markers: ["band-275", "band-276"], messages: [textMessage("tool", "bounded output")] },
    output: { status: "ok", action: "passthrough", decision: "materialize" },
  },
] as const;

const canonical = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
const inputHash = createHash("sha256").update(canonical(scenarios.map(({ id, family, input }) => ({ id, family, input })))).digest("hex");
const golden = {
  schema: 1,
  provenance: {
    generator: "crates/mc-module/gen/gen-differential-golden.ts",
    generator_version: generatorVersion,
    input_sha256: inputHash,
  },
  cases: scenarios.map(({ id, family, input, output }) => ({
    id,
    family,
    input,
    expected: { ...output, wire: input.messages },
  })),
};

const outPath = join(dirname(import.meta.path), "../testdata/differential-golden.json");
await Bun.write(outPath, canonical(golden));
console.log(`wrote ${outPath} (${golden.cases.length} DG cases, input ${inputHash})`);
