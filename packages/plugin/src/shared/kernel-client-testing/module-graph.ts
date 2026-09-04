/**
 * Reachability is read from the bundler's metafile rather than from the
 * emitted text, so a claim about what an entry imports is not fooled by a
 * string that happens to appear in a comment or a log line.
 */

/** The Pi `build` script's externals; the graph stops at these package boundaries. */
export const BUNDLE_EXTERNALS = [
    "@cortexkit/mc-shm-native",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "@huggingface/transformers",
    "node:sqlite",
] as const;

export interface ModuleGraph {
    /** Every source module in the bundle, as the bundler names it relative to the working directory. */
    inputs: string[];
    /** Every specifier an input imports that stays external, since those never appear in `inputs`. */
    externals: string[];
    /** The bundled text, for claims about emitted bytes such as which externals stay external. */
    text: string;
}

interface MetafileInput {
    imports?: { path?: string; external?: boolean }[];
}

export async function bundleModuleGraph(entry: string): Promise<ModuleGraph> {
    const result = await Bun.build({
        entrypoints: [entry],
        target: "node",
        format: "esm",
        external: [...BUNDLE_EXTERNALS],
        metafile: true,
    });
    if (!result.success) {
        throw new Error(`bundle of ${entry} failed: ${result.logs.map(String).join("\n")}`);
    }
    if (result.outputs.length === 0) throw new Error(`bundle of ${entry} produced no output`);
    // The runtime hands the metafile back as an object; the type declares a JSON string.
    const raw: unknown = result.metafile;
    const metafile = (typeof raw === "string" ? JSON.parse(raw) : raw) as
        | { inputs?: Record<string, MetafileInput> }
        | undefined;
    if (!metafile?.inputs) throw new Error(`bundle of ${entry} produced no metafile`);
    const texts = await Promise.all(result.outputs.map((output) => output.text()));
    const externals = new Set<string>();
    for (const input of Object.values(metafile.inputs)) {
        for (const edge of input.imports ?? []) {
            if (edge.external === true && typeof edge.path === "string") externals.add(edge.path);
        }
    }
    return {
        inputs: Object.keys(metafile.inputs),
        externals: [...externals],
        text: texts.join("\n"),
    };
}

/** Module and external-specifier paths matching `pattern`. */
export function reachableModules(graph: ModuleGraph, pattern: RegExp): string[] {
    return [...graph.inputs, ...graph.externals].filter((path) => pattern.test(path));
}
