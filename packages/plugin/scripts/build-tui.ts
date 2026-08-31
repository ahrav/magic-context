import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runtimeModuleId, TUI_RUNTIME_SPECIFIERS } from "../src/shared/tui-runtime-specifiers";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(pluginRoot, "src/tui");
const outputRoot = join(pluginRoot, "src/tui-compiled");
const runtimeSpecifiers: Set<string> = new Set(TUI_RUNTIME_SPECIFIERS);

type TransformSolidSource = (
    code: string,
    options: {
        filename: string;
        moduleName: string;
        resolvePath: (specifier: string) => string | null;
    },
) => Promise<string>;

type SolidTransformModule = {
    transformSolidSource?: TransformSolidSource;
};


/**
 *
 *
 *
 */
async function loadRuntimeExportSets(): Promise<{
    openTui: Set<string>;
    solid: Set<string>;
}> {
    const [openTuiModule, solidModule] = await Promise.all([
        import("@opentui/solid"),
        import("solid-js"),
    ]);
    return {
        openTui: new Set(Object.keys(openTuiModule)),
        solid: new Set(Object.keys(solidModule)),
    };
}

const OPENTUI_SOLID_RUNTIME_ID = runtimeModuleId("@opentui/solid");
const SOLID_JS_RUNTIME_ID = runtimeModuleId("solid-js");

const SINGLE_SPECIFIER_IMPORT =
    /^import \{\s*([A-Za-z_$][\w$]*)(\s+as\s+[A-Za-z_$][\w$]*)?\s*\} from "([^"]+)";$/;

function redirectBuiltinImports(
    code: string,
    exportSets: { openTui: Set<string>; solid: Set<string> },
    sourceFile: string,
): string {
    const unresolved: string[] = [];

    const rewritten = code
        .split("\n")
        .map((line) => {
            const match = SINGLE_SPECIFIER_IMPORT.exec(line);
            if (!match) return line;

            const [, importedName, alias, moduleId] = match;
            if (moduleId !== OPENTUI_SOLID_RUNTIME_ID) return line;
            if (exportSets.openTui.has(importedName)) return line;

            if (!exportSets.solid.has(importedName)) {
                unresolved.push(importedName);
                return line;
            }

            return `import {${alias ? ` ${importedName}${alias} ` : ` ${importedName} `}} from "${SOLID_JS_RUNTIME_ID}";`;
        })
        .join("\n");

    if (unresolved.length > 0) {
        throw new Error(
            `${sourceFile}: compiled TUI imports ${unresolved
                .map((name) => `'${name}'`)
                .join(", ")} which neither @opentui/solid nor solid-js exports. ` +
                "Shipping this bundle would make the host drop the sidebar silently.",
        );
    }

    return rewritten;
}

function asTransformSolidSource(mod: SolidTransformModule, from: string): TransformSolidSource {
    if (typeof mod.transformSolidSource !== "function") {
        throw new Error(`@opentui/solid transform loaded from ${from} without transformSolidSource`);
    }
    return mod.transformSolidSource;
}

async function importTransformModule(specifier: string): Promise<SolidTransformModule> {
    return (await import(specifier)) as SolidTransformModule;
}

async function resolveSolidTransformPath(): Promise<string> {
    const packageJsonSpecifier = "@opentui/solid/package.json";
    const errors: string[] = [];

    try {
        const packageJsonUrl = import.meta.resolve(packageJsonSpecifier);
        return join(dirname(fileURLToPath(packageJsonUrl)), "scripts/solid-transform.js");
    } catch (error) {
        errors.push(`import.meta.resolve: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
        const require = createRequire(import.meta.url);
        return join(dirname(require.resolve(packageJsonSpecifier)), "scripts/solid-transform.js");
    } catch (error) {
        errors.push(`require.resolve: ${error instanceof Error ? error.message : String(error)}`);
    }

    throw new Error(`Unable to resolve @opentui/solid transform (${errors.join("; ")})`);
}

async function loadTransformSolidSource(): Promise<TransformSolidSource> {
    const bareTransformSpecifier = "@opentui/solid/scripts/solid-transform.js";

    try {
        return asTransformSolidSource(
            await importTransformModule(bareTransformSpecifier),
            bareTransformSpecifier,
        );
    } catch {
        const transformPath = await resolveSolidTransformPath();
        return asTransformSolidSource(
            await importTransformModule(pathToFileURL(transformPath).href),
            transformPath,
        );
    }
}

function isShippedSourceFile(filePath: string): boolean {
    if (/\.test\.tsx?$/.test(basename(filePath))) return false;
    return filePath.endsWith(".tsx") || filePath.endsWith(".ts");
}

async function listSourceFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const files: string[] = [];
    for (const entry of entries) {
        const entryPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await listSourceFiles(entryPath)));
        } else if (entry.isFile() && isShippedSourceFile(entryPath)) {
            files.push(entryPath);
        }
    }
    return files;
}

async function copyPlainTypeScript(sourceFile: string, outputFile: string): Promise<void> {
    await mkdir(dirname(outputFile), { recursive: true });
    await copyFile(sourceFile, outputFile);
}

async function compileTsx(
    transformSolidSource: TransformSolidSource,
    sourceFile: string,
    outputFile: string,
    exportSets: { openTui: Set<string>; solid: Set<string> },
): Promise<void> {
    const code = await readFile(sourceFile, "utf8");
    const compiled = await transformSolidSource(code, {
        filename: sourceFile,
        moduleName: runtimeModuleId("@opentui/solid"),
        resolvePath: (specifier: string) =>
            runtimeSpecifiers.has(specifier) ? runtimeModuleId(specifier) : null,
    });

    await mkdir(dirname(outputFile), { recursive: true });
    await writeFile(outputFile, redirectBuiltinImports(compiled, exportSets, sourceFile));
}

const transformSolidSource = await loadTransformSolidSource();
const runtimeExportSets = await loadRuntimeExportSets();
const files = await listSourceFiles(sourceRoot);

await rm(outputRoot, { recursive: true, force: true });

for (const sourceFile of files) {
    const relativePath = relative(sourceRoot, sourceFile);
    const outputFile = join(outputRoot, relativePath);

    if (sourceFile.endsWith(".tsx")) {
        await compileTsx(transformSolidSource, sourceFile, outputFile, runtimeExportSets);
    } else {
        await copyPlainTypeScript(sourceFile, outputFile);
    }
}

console.log(`build-tui: wrote ${files.length} file(s) to ${relative(pluginRoot, outputRoot)}`);
