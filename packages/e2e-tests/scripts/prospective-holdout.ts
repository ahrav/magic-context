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
import { parseProspectiveReport, type ReportRecomputers } from "../src/prospective-holdout/report";
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
            const root = resolve(args[1] ?? resolve(import.meta.dir, ".."));
            const result = validateHoldoutRepository(root, recomputers);
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
        if (command && command in TRANSITIONS) {
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
