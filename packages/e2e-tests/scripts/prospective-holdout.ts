#!/usr/bin/env bun

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalJson, readCanonicalJsonFile } from "../../plugin/scripts/retrieval-benchmark/canonical-json";
import { HoldoutContractError } from "../src/prospective-holdout/contract";
import {
    parseLifecycleEvent,
    parseLifecycleLedger,
    validateLifecycle,
    type LifecycleEvent,
    type LifecycleState,
} from "../src/prospective-holdout/lifecycle";
import {
    parseProspectiveReport,
    type FamilyEstimatorAdapter,
    type ReportRecomputers,
    type ScorecardAdapter,
} from "../src/prospective-holdout/report";
import { validateHoldoutRepository } from "../src/prospective-holdout/validation";

interface CliIo {
    out(message: string): void;
    err(message: string): void;
}

const TRANSITIONS: Record<string, readonly LifecycleState[]> = {
    freeze: ["frozen"],
    "open-intake": ["intake-open"],
    close: ["cohort-closed"],
    compare: ["running"],
    report: ["reported", "insufficient-evidence"],
    graduate: ["graduated"],
    invalidate: ["invalidated"],
};

function readLifecycle(path: string): LifecycleEvent[] {
    return existsSync(path) ? parseLifecycleLedger(readFileSync(path, "utf8")) : [];
}

interface ValidateInvocation {
    root: string | undefined;
    recomputersSpecifier: string | undefined;
}

function parseValidateArgs(args: readonly string[]): ValidateInvocation {
    let root: string | undefined;
    let recomputersSpecifier: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
        const token: string | undefined = args[index];
        if (token === "--recomputers") {
            const specifier: string | undefined = args[index + 1];
            if (specifier === undefined) throw new HoldoutContractError(["recomputers: specifier-required"]);
            recomputersSpecifier = specifier;
            index += 1;
            continue;
        }
        root ??= token;
    }
    return { root, recomputersSpecifier };
}

/** An export passes only when it carries both the sibling owner id and its recomputation method. */
function adapterOwner(value: unknown, method: string): string | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const adapter = value as Record<string, unknown>;
    if (typeof adapter[method] !== "function" || typeof adapter.owner !== "string") return undefined;
    return adapter.owner;
}

async function loadRecomputers(specifier: string): Promise<ReportRecomputers> {
    // Path-like specifiers resolve against the process working directory; bare ones stay
    // untouched so the module resolver keeps its own lookup rules.
    const target = /^[./]/.test(specifier) ? resolve(specifier) : specifier;
    let loaded: Record<string, unknown>;
    try {
        loaded = (await import(target)) as Record<string, unknown>;
    } catch {
        throw new HoldoutContractError(["recomputers: unloadable"]);
    }
    if (
        adapterOwner(loaded.estimator, "analyze") !== "magic-context-x4l.14" ||
        adapterOwner(loaded.scorecard, "evaluate") !== "magic-context-x4l.15"
    ) {
        throw new HoldoutContractError(["recomputers: adapter-invalid"]);
    }
    return {
        estimator: loaded.estimator as FamilyEstimatorAdapter,
        scorecard: loaded.scorecard as ScorecardAdapter,
    };
}

function appendPrebuiltTransition(command: string, ledgerPath: string, eventPath: string): void {
    const raw = readCanonicalJsonFile(
        eventPath,
        (code) => new HoldoutContractError([`event:${code}`]),
    );
    const event = parseLifecycleEvent(raw, "event");
    if (!TRANSITIONS[command]!.includes(event.state)) {
        throw new HoldoutContractError([`${command}: event-state-invalid`]);
    }
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const lock = `${ledgerPath}.lock`;
    try {
        mkdirSync(lock);
    } catch {
        throw new HoldoutContractError(["lifecycle: append-busy"]);
    }
    try {
        const prior = readLifecycle(ledgerPath);
        validateLifecycle([...prior, event], { epochId: event.epochId });
        appendFileSync(ledgerPath, `${canonicalJson(event)}\n`, { flag: "a" });
    } finally {
        rmSync(lock, { recursive: true, force: true });
    }
}

export async function runProspectiveHoldoutCli(args: string[], io: CliIo = {
    out: (message) => console.log(message),
    err: (message) => console.error(message),
}, recomputers?: ReportRecomputers): Promise<number> {
    try {
        const command = args[0];
        if (command === "validate") {
            const invocation = parseValidateArgs(args.slice(1));
            const root = resolve(invocation.root ?? resolve(import.meta.dir, ".."));
            const adapters = recomputers
                ?? (invocation.recomputersSpecifier === undefined
                    ? undefined
                    : await loadRecomputers(invocation.recomputersSpecifier));
            const result = validateHoldoutRepository(root, adapters);
            io.out(`prospective-holdout valid epochs=${result.epochCount}`);
            return 0;
        }
        if (command === "validate-report") {
            if (args.length !== 2) throw new HoldoutContractError(["validate-report: path-required"]);
            const raw = readCanonicalJsonFile(args[1]!, (code) => new HoldoutContractError([`report:${code}`]));
            parseProspectiveReport(raw);
            io.out("prospective-report valid");
            return 0;
        }
        if (command && Object.hasOwn(TRANSITIONS, command)) {
            if (args.length !== 3) throw new HoldoutContractError([`${command}: ledger-and-event-required`]);
            appendPrebuiltTransition(command, args[1]!, args[2]!);
            io.out(`prospective-transition appended state=${TRANSITIONS[command]!.join("|")}`);
            return 0;
        }
        throw new HoldoutContractError([
            "usage: prospective-holdout <validate|validate-report|freeze|open-intake|close|compare|report|graduate|invalidate>",
        ]);
    } catch (error) {
        io.err(error instanceof Error ? error.message : "prospective-holdout: failed");
        return 1;
    }
}

if (import.meta.main) {
    process.exit(await runProspectiveHoldoutCli(Bun.argv.slice(2)));
}
