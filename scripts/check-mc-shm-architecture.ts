#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_ROOTS = [
    "crates/mc-host/src",
    "crates/mc-shm-transport/src",
    "packages/mc-shm-native/src",
    "packages/plugin/src/shared/mc-host-client",
    "packages/plugin/src/shared/mc-host-lifecycle",
] as const;

const SOURCE_FILES = ["packages/mc-shm-native/index.ts"] as const;
const MANIFESTS = [
    "Cargo.toml",
    "Cargo.lock",
    "crates/mc-host/Cargo.toml",
    "crates/mc-shm-transport/Cargo.toml",
    "packages/mc-shm-native/package.json",
    "packages/plugin/package.json",
] as const;

const FORBIDDEN_SOURCE: readonly [string, RegExp][] = [
    ["production TCP application transport", /\b(?:TcpListener|TcpStream|tcp_frame_channel)\b|node:net/],
    ["transport negotiation or compatibility operation", /transport\.(?:negotiate|activate|commit)|\bnegotiation_failed\b/],
    ["transport fallback state", /\b(?:fallback_reason|selected_transport|transport_fallback)\b/i],
    ["transport provider selection", /\b(?:BackendId|transport_provider|provider_recovery|provider_registry)\b/],
    ["alternate shared-memory backend", /\biceoryx2?\b/i],
    ["legacy transport compatibility branch", /\b(?:legacy|compat(?:ibility)?)_(?:transport|wire|ring|descriptor)\b/i],
    ["shared-memory prefault", /\b(?:prefault_[A-Za-z0-9_]*|Prefault[A-Za-z0-9_]*|MAP_POPULATE|MADV_POPULATE_(?:READ|WRITE))\b/],
    ["runtime scheduling selector", /\bSchedulingMode\b/],
    ["50 microsecond ring polling", /(?:thread::sleep\s*\(\s*)?Duration::from_micros\s*\(\s*50\s*\)/],
    ["production JavaScript interval polling", /\bsetInterval\s*\(/],
    ["libuv poll integration", /\b(?:uv_poll_(?:init|start|stop)|napi_get_uv_event_loop)\b/],
];

const FORBIDDEN_PATH = /(?:tcp[-_]frame[-_]channel|transport[-_]negotiation|transport[-_]provider|provider[-_]recovery|iceoryx)/i;
const FORBIDDEN_DEPENDENCY = /\biceoryx2?(?:-sys)?\b/i;

export interface ArchitectureViolation {
    path: string;
    rule: string;
}

function sourceFiles(root: string): string[] {
    if (!existsSync(root)) return [];
    const files: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) files.push(...sourceFiles(path));
        else if ([".rs", ".ts", ".tsx"].includes(extname(path)) && !path.endsWith(".test.ts")) {
            files.push(path);
        }
    }
    return files;
}

export function findArchitectureViolations(workspace: string): ArchitectureViolation[] {
    const violations: ArchitectureViolation[] = [];
    const required = [...SOURCE_ROOTS, ...SOURCE_FILES, ...MANIFESTS];
    for (const path of required) {
        if (!existsSync(join(workspace, path))) violations.push({ path, rule: "required audit input missing" });
    }

    const files = [
        ...SOURCE_ROOTS.flatMap((path) => sourceFiles(join(workspace, path))),
        ...SOURCE_FILES.map((path) => join(workspace, path)).filter(existsSync),
    ];
    for (const path of files) {
        const display = relative(workspace, path);
        if (FORBIDDEN_PATH.test(display)) {
            violations.push({ path: display, rule: "obsolete transport module" });
        }
        const source = readFileSync(path, "utf8");
        for (const [rule, pattern] of FORBIDDEN_SOURCE) {
            if (pattern.test(source)) violations.push({ path: display, rule });
        }
    }

    for (const manifest of MANIFESTS) {
        const path = join(workspace, manifest);
        if (existsSync(path) && FORBIDDEN_DEPENDENCY.test(readFileSync(path, "utf8"))) {
            violations.push({ path: manifest, rule: "alternate backend dependency" });
        }
    }
    return violations;
}

function main(): void {
    const workspace = resolve(fileURLToPath(new URL("..", import.meta.url)));
    const violations = findArchitectureViolations(workspace);
    if (violations.length === 0) {
        console.log("mandatory ring architecture: ok");
        return;
    }
    for (const violation of violations) console.error(`${violation.path}: ${violation.rule}`);
    process.exitCode = 1;
}

if (import.meta.main) main();
