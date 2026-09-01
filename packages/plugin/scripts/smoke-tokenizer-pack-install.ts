import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageName = "@cortexkit/opencode-magic-context";

function run(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv = process.env,
    printOutput = true,
): { stdout: string; stderr: string } {
    const result = spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 20 * 1024 * 1024,
    });

    if (printOutput && result.stdout) process.stdout.write(result.stdout);
    if (printOutput && result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? "unknown status"}`);
    }
    return { stdout: result.stdout, stderr: result.stderr };
}

function parsePackedFilename(stdout: string): string {
    try {
        const packed = JSON.parse(stdout.trim()) as Array<{ filename?: string }>;
        const filename = packed[0]?.filename;
        if (typeof filename === "string" && filename.length > 0) return filename;
    } catch {
        // The fallback tolerates npm output variations.
    }

    const fallback = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.endsWith(".tgz"))
        .at(-1);
    if (fallback) return fallback;
    throw new Error(`npm pack did not report a tarball: ${stdout.trim() || "no stdout"}`);
}

const tempRoot = await mkdtemp(join(tmpdir(), "magic-context-tokenizer-pack-"));
const cacheRoot = join(tempRoot, "cache");
const installRoot = join(cacheRoot, "opencode");
const projectRoot = join(tempRoot, "project");
const dataRoot = join(tempRoot, "data");
const hostSource = join(installRoot, "tokenizer-host.mjs");
const hostExecutable = join(tempRoot, process.platform === "win32" ? "opencode-host.exe" : "opencode-host");

try {
    run("bun", ["run", "build"], pluginRoot);

    const packStdout = run(
        "npm",
        ["pack", "--json", "--pack-destination", tempRoot],
        pluginRoot,
        process.env,
        false,
    ).stdout;
    const tarball = join(tempRoot, parsePackedFilename(packStdout));
    if (!existsSync(tarball)) throw new Error(`npm pack did not create ${tarball}`);

    await mkdir(join(projectRoot, ".cortexkit"), { recursive: true });
    await writeFile(join(projectRoot, ".cortexkit", "magic-context.jsonc"), '{ "enabled": false }\n');
    await mkdir(installRoot, { recursive: true });
    await writeFile(
        join(installRoot, "package.json"),
        JSON.stringify(
            {
                private: true,
                type: "module",
                dependencies: {
                    [packageName]: `file:${tarball}`,
                },
            },
            null,
            2,
        ),
    );
    run("npm", ["install", "--omit=dev", "--ignore-scripts"], installRoot);
    const canonicalCacheRoot = await realpath(cacheRoot);

    await writeFile(
        hostSource,
        `import plugin from ${JSON.stringify(packageName)};

const projectRoot = process.argv[2];
if (!projectRoot) throw new Error("missing project root");
console.log("compiled host import.meta.url=" + JSON.stringify(import.meta.url));
const hooks = await plugin.server({ directory: projectRoot, worktree: projectRoot, client: {} });
await hooks["chat.message"]?.({
  model: { providerID: "smoke-provider", modelID: "smoke-model" },
  agent: "smoke-agent",
}, {});
await hooks["tool.definition"]?.(
  { toolID: "smoke-tool" },
  { description: "Exercise lazy tokenizer resolution", parameters: { type: "object" } },
);
await hooks["tool.definition"]?.(
  { toolID: "smoke-tool-second" },
  { description: "Exercise the tokenizer a second time", parameters: { type: "object" } },
);
console.log("packed tokenizer estimates completed");
`,
    );

    // The compiled host reproduces Bun's virtual `/$bunfs/root` module base.
    // Bun's `/$bunfs/root` module base makes `createRequire(import.meta.url)` unusable.
    run("bun", ["build", "--compile", hostSource, "--outfile", hostExecutable], installRoot);
    const resolvedOutput = run(hostExecutable, [projectRoot], projectRoot, {
        ...process.env,
        XDG_CACHE_HOME: canonicalCacheRoot,
        MAGIC_CONTEXT_TEST_DATA_DIR: dataRoot,
    });
    if (!resolvedOutput.stdout.includes("packed tokenizer estimates completed")) {
        throw new Error("compiled packed-install probe did not exercise tokenizer estimates");
    }
    if (resolvedOutput.stderr.includes("ai-tokenizer is unavailable")) {
        throw new Error("packed tokenizer resolved only through the approximate fallback");
    }

    const emptyCacheRoot = join(tempRoot, "empty-cache");
    await mkdir(emptyCacheRoot, { recursive: true });
    const fallbackOutput = run(hostExecutable, [projectRoot], projectRoot, {
        ...process.env,
        XDG_CACHE_HOME: emptyCacheRoot,
        MAGIC_CONTEXT_TEST_DATA_DIR: dataRoot,
    });
    if (!fallbackOutput.stdout.includes("packed tokenizer estimates completed")) {
        throw new Error("tokenizer resolution failure did not degrade to approximate estimates");
    }
    const fallbackWarnings = fallbackOutput.stderr.match(/ai-tokenizer is unavailable/g)?.length ?? 0;
    if (fallbackWarnings !== 1) {
        throw new Error(`expected one tokenizer fallback warning, got ${fallbackWarnings}`);
    }
} finally {
    if (process.env.KEEP_TOKENIZER_PACK_SMOKE !== "1") {
        await rm(tempRoot, { recursive: true, force: true });
    } else {
        console.log(`kept smoke temp dir: ${tempRoot}`);
    }
}

console.log("smoke-tokenizer-pack-install: all checks passed");
