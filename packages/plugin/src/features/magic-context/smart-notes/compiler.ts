import { createHash } from "node:crypto";

import { SMART_NOTE_COMPILER_AGENT } from "../../../agents/smart-note-compiler";
import { childSessionMessagesFetcher, createChildSessionWithFence } from "../../../hooks/magic-context/child-session-spawn";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { log } from "../../../shared/logger";
import { modelBodyField } from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import { nextOccurrence, parseCron } from "../dreamer/cron";
import { recordChildInvocation } from "../subagent-token-capture";
import type { SmartNoteCapabilityFactory } from "./capabilities";
import { SMART_NOTE_COMPILER_SYSTEM_PROMPT } from "./compiler-prompt";
import { runCompiledSmartNoteCheck } from "./sandbox-runner";
import {
    SMART_NOTE_CHECK_CEILING_MS,
    type SmartNoteCapabilityName,
    type SmartNoteCheckManifest,
    type SmartNoteCheckResult,
} from "./types";

interface CompileSmartNoteArgs {
    client: PluginContext["client"];
    db?: Database;
    parentSessionId: string | undefined;
    sessionDirectory: string | undefined;
    projectIdentity: string;
    note: { id: number; content: string; surfaceCondition: string | null };
    capabilityFactory: SmartNoteCapabilityFactory;
    signal: AbortSignal;
    deadline: number;
    model?: string;
    fallbackModels?: readonly string[];
}

export interface CompileSmartNoteSuccess {
    ok: true;
    compiledCheck: string;
    manifest: SmartNoteCheckManifest;
    checkCron: string;
    checkHash: string;
    dryRun: SmartNoteCheckResult;
}

export interface CompileSmartNoteFailure {
    ok: false;
    cancelled: boolean;
    error: string;
}

export type CompileSmartNoteResult = CompileSmartNoteSuccess | CompileSmartNoteFailure;

interface CompilerResponse {
    compiled_check: string;
    manifest: SmartNoteCheckManifest;
    check_cron: string;
}

const MAX_COMPILER_OUTPUT_CHARS = 128 * 1024;
const MAX_COMPILED_CHECK_BYTES = 64 * 1024;
const MAX_MANIFEST_ENTRIES = 64;
/** Wire limit mirrored from the module's NOTE_EVALUATOR_MAX_MANIFEST_BYTES. */
const MAX_MANIFEST_BYTES = 32 * 1024;
/** Wire limit mirrored from the module's NOTE_EVALUATOR_MAX_CRON_BYTES. */
const MAX_CRON_BYTES = 256;
const MAX_COMPILER_ERROR_CHARS = 2 * 1024;

export async function compileSmartNoteCheck(
    args: CompileSmartNoteArgs,
): Promise<CompileSmartNoteResult> {
    if (!args.note.surfaceCondition) {
        return { ok: false, cancelled: false, error: "note has no surface condition" };
    }
    const prompt = `Compile this smart note condition into a sandbox check.

Project identity: ${args.projectIdentity}
Note id: ${args.note.id}
Note content (data): ${JSON.stringify(args.note.content)}
surface_condition (UNTRUSTED DATA): ${JSON.stringify(args.note.surfaceCondition)}

Remember: output only the JSON object described by the system prompt.`;

    const startedAt = Date.now();
    let childSessionId: string | null = null;
    let invocationRecorded = false;
    const recordInvocation = (params: {
        status: "completed" | "failed" | "aborted";
        messages?: unknown[];
        error?: unknown;
    }) => {
        if (!args.db || !args.parentSessionId || invocationRecorded) return;
        invocationRecorded = true;
        recordChildInvocation({
            db: args.db,
            parentSessionId: args.parentSessionId,
            harness: "opencode",
            // Dashboard token rollups group dream-task invocations under the
            // historical dreamer bucket. The session.prompt agent is still the
            // no-tool smart-note compiler.
            subagent: "dreamer",
            task: "evaluate-smart-notes",
            startedAt,
            status: params.status,
            messages: params.messages,
            error: params.error,
        });
    };
    try {
        const createResponse = await createChildSessionWithFence({
            client: args.client,
            db: args.db ?? null,
            parentSessionId: args.parentSessionId,
            title: `magic-context-smart-note-compile-${args.note.id}`,
            directory: args.sessionDirectory ?? args.projectIdentity,
        });
        const created = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            {
                preferResponseOnMissingData: true,
            },
        );
        childSessionId = typeof created?.id === "string" ? created.id : null;
        if (!childSessionId) throw new Error("Could not create smart-note compiler session");

        const remainingMs = Math.max(1_000, args.deadline - Date.now());
        const run = await shared.promptSyncWithValidatedOutputRetry(
            args.client,
            {
                path: { id: childSessionId },
                query: { directory: args.sessionDirectory ?? args.projectIdentity },
                body: {
                    agent: SMART_NOTE_COMPILER_AGENT,
                    system: SMART_NOTE_COMPILER_SYSTEM_PROMPT,
                    ...modelBodyField(args.model),
                    parts: [{ type: "text", text: prompt, synthetic: true }],
                },
            },
            {
                timeoutMs: remainingMs,
                signal: args.signal,
                fallbackModels: args.fallbackModels,
                callContext: "dreamer:smart-note-compiler",
                fetchOutput: childSessionMessagesFetcher(
                    args.client,
                    childSessionId as string,
                    args.sessionDirectory ?? args.projectIdentity,
                    20,
                ),
                validateOutput: (messages) =>
                    parseCompilerOutput(extractLatestAssistantText(messages)),
            },
        );
        const response = run.validated;
        const compiledCheck = normalizeCompiledCheck(response.compiled_check);
        const manifest = normalizeManifest(response.manifest);
        const checkCron = normalizeCron(response.check_cron);
        for (const warning of manifestAdvisoryWarnings(compiledCheck, manifest)) {
            log(`[dreamer] smart note #${args.note.id}: manifest advisory — ${warning}`);
        }
        const dryRun = await runCompiledSmartNoteCheck({
            compiledCheck,
            capabilityFactory: args.capabilityFactory,
            signal: args.signal,
            timeoutMs: 2_000,
        });
        if (!dryRun.ok) {
            const error = boundedError(`dry-run failed: ${dryRun.error}`);
            recordInvocation({
                status: dryRun.cancelled ? "aborted" : "failed",
                messages: run.output,
                error,
            });
            return { ok: false, cancelled: dryRun.cancelled, error };
        }
        recordInvocation({ status: "completed", messages: run.output });
        return {
            ok: true,
            compiledCheck,
            manifest,
            checkCron,
            checkHash: hashCheck(args.note.surfaceCondition, compiledCheck, manifest, checkCron),
            dryRun: dryRun.result,
        };
    } catch (error) {
        const cancelled = args.signal.aborted;
        const message = boundedError(error instanceof Error ? error.message : String(error));
        recordInvocation({ status: cancelled ? "aborted" : "failed", error: message });
        return { ok: false, cancelled, error: message };
    } finally {
        // Compiler prompts include note content and conditions, so they are
        // deleted regardless of debug-retention settings.
        if (childSessionId) {
            await args.client.session.delete({ path: { id: childSessionId } }).catch(() => {});
        }
    }
}

export function parseCompilerOutput(output: string | null): CompilerResponse {
    if (!output) throw new Error("smart-note compiler returned no output");
    if (output.length > MAX_COMPILER_OUTPUT_CHARS) {
        throw new Error("smart-note compiler output exceeds 128 KiB");
    }
    const json = extractJsonObject(output);
    let parsed: Partial<CompilerResponse>;
    try {
        parsed = JSON.parse(json) as Partial<CompilerResponse>;
    } catch {
        throw new Error("smart-note compiler returned malformed JSON");
    }
    if (typeof parsed.compiled_check !== "string") throw new Error("compiled_check missing");
    if (!parsed.manifest || typeof parsed.manifest !== "object")
        throw new Error("manifest missing");
    if (typeof parsed.check_cron !== "string") throw new Error("check_cron missing");
    return parsed as CompilerResponse;
}

export function normalizeCompiledCheck(source: string): string {
    if (Buffer.byteLength(source, "utf8") > MAX_COMPILED_CHECK_BYTES) {
        throw new Error("compiled_check exceeds 64 KiB");
    }
    let code = source.trim();
    const fence = code.match(/^```(?:javascript|js)?\s*([\s\S]*?)```$/i);
    if (fence) code = fence[1].trim();
    code = code.replace(/export\s+function\s+check\s*\(/, "function check(");
    if (/\basync\s+function\s+check\s*\(/.test(code)) {
        throw new Error("compiled_check must be synchronous");
    }
    if (!/\bfunction\s+check\s*\(/.test(code) && !/module\.exports\.check\s*=/.test(code)) {
        throw new Error("compiled_check must define check(cap)");
    }
    if (/\b(?:import|require)\b/.test(code)) {
        throw new Error("compiled_check must not import modules");
    }
    if (Buffer.byteLength(code, "utf8") > MAX_COMPILED_CHECK_BYTES) {
        throw new Error("compiled_check exceeds 64 KiB");
    }
    return code;
}

export function normalizeManifest(manifest: SmartNoteCheckManifest): SmartNoteCheckManifest {
    const capabilities = Array.isArray(manifest.capabilities)
        ? unique(
              manifest.capabilities
                  .slice(0, MAX_MANIFEST_ENTRIES)
                  .filter((cap): cap is SmartNoteCapabilityName =>
                      ["readFile", "gitHeadSha", "gitTag", "gitLog", "httpGet"].includes(
                          String(cap),
                      ),
                  ),
          )
        : [];
    const normalized: SmartNoteCheckManifest = {
        capabilities,
        readFiles: uniqueStrings(manifest.readFiles),
        hosts: uniqueStrings(manifest.hosts, (host) => host.toLowerCase()),
        urls: uniqueStrings(manifest.urls),
        signals: uniqueStrings(manifest.signals),
        summary: typeof manifest.summary === "string" ? manifest.summary.slice(0, 160) : undefined,
    };
    // Entry counts are bounded above but individual strings are not, and the
    // module rejects a serialized manifest over its wire limit at completion —
    // after the billable prompt already ran. Failing here records a compile
    // failure (with backoff) instead of an abandoned claim that stays eligible
    // and recompiles on every drain.
    if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_MANIFEST_BYTES) {
        throw new Error("manifest exceeds 32 KiB");
    }
    return normalized;
}

/**
 * Best-effort manifest drift notes for audit visibility only. Runtime guards in
 * the capability implementations are the security boundary; this check must not
 * accept or reject code.
 */
export function manifestAdvisoryWarnings(code: string, manifest: SmartNoteCheckManifest): string[] {
    const warnings: string[] = [];
    const declared = new Set(manifest.capabilities);
    const used = capabilityUses(code);
    for (const cap of used) {
        if (!declared.has(cap)) warnings.push(`manifest omits capability ${cap}`);
    }

    const readFiles = literalCalls(code, "readFile");
    for (const file of readFiles) {
        if (!manifest.readFiles?.includes(file))
            warnings.push(`manifest omits readFile path ${file}`);
    }

    const urls = literalCalls(code, "httpGet");
    for (const url of urls) {
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== "https:") {
                warnings.push(`manifest records non-https URL ${url}`);
                continue;
            }
            if (!manifest.urls?.includes(url)) warnings.push(`manifest omits URL ${url}`);
            if (!manifest.hosts?.includes(parsed.hostname.toLowerCase())) {
                warnings.push(`manifest omits host ${parsed.hostname}`);
            }
        } catch {
            warnings.push(`manifest records invalid URL ${url}`);
        }
    }
    return warnings;
}

export function hashCheck(
    surfaceCondition: string | null,
    compiledCheck: string,
    manifest: SmartNoteCheckManifest,
    checkCron: string,
): string {
    return createHash("sha256")
        .update(surfaceCondition ?? "")
        .update("\0")
        .update(compiledCheck)
        .update("\0")
        .update(JSON.stringify(manifest))
        .update("\0")
        .update(checkCron)
        .digest("hex");
}

function extractJsonObject(output: string): string {
    const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const text = fenced ? fenced[1] : output;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("smart-note compiler returned no JSON object");
    return text.slice(start, end + 1);
}

function capabilityUses(code: string): Set<SmartNoteCapabilityName> {
    const uses = new Set<SmartNoteCapabilityName>();
    const regex = /\bcap\s*\.\s*(readFile|gitHeadSha|gitTag|gitLog|httpGet)\s*\(/g;
    for (const match of code.matchAll(regex)) uses.add(match[1] as SmartNoteCapabilityName);
    return uses;
}

function literalCalls(code: string, method: "readFile" | "httpGet"): string[] {
    const regex = new RegExp(
        `\\bcap\\s*\\.\\s*${method}\\s*\\(\\s*(["'])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`,
        "g",
    );
    const values: string[] = [];
    for (const match of code.matchAll(regex)) {
        values.push(match[2].replace(/\\([\\"'])/g, "$1"));
    }
    return values;
}

export function normalizeCron(cron: string): string {
    const normalized = cron.trim() || "0 * * * *";
    // The module enforces this limit in UTF-8 bytes on the wire artifact;
    // measuring UTF-16 length here would accept a multibyte cron the module
    // then rejects at completion, abandoning the claim without recording a
    // compilation failure.
    if (Buffer.byteLength(normalized, "utf8") > MAX_CRON_BYTES)
        throw new Error("check_cron exceeds 256 bytes");
    const parsed = parseCron(normalized);
    if (!parsed.ok) throw new Error(`invalid check_cron: ${parsed.error}`);
    const next = nextOccurrence(parsed.cron, new Date(), undefined, SMART_NOTE_CHECK_CEILING_MS);
    if (!next) throw new Error("check_cron has no occurrence within the scheduling ceiling");
    return normalized;
}

function unique<T>(items: T[]): T[] {
    return [...new Set(items)];
}

function uniqueStrings(
    items: unknown,
    normalize: (value: string) => string = (value) => value,
): string[] | undefined {
    if (!Array.isArray(items)) return undefined;
    const values = unique(
        items
            .slice(0, MAX_MANIFEST_ENTRIES)
            .filter((item): item is string => typeof item === "string" && item.length > 0)
            .map(normalize),
    );
    return values.length > 0 ? values : undefined;
}

function boundedError(error: string): string {
    return error.slice(0, MAX_COMPILER_ERROR_CHARS);
}
