#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    compareWithAcceptedSnapshot,
    splitLedgerLines,
    validateIncidentHistory,
    type HistorySnapshot,
    type IncidentHistoryState,
} from "../src/incident-pool/history";

export const E2E_ROOT = resolve(import.meta.dir, "..");
export const INCIDENTS_DIR = resolve(E2E_ROOT, "incidents");

function readIncidentFile(dir: string, name: string): string {
    const path = resolve(dir, name);
    try {
        return readFileSync(path, "utf8");
    } catch (error) {
        throw new Error(`could not read ${path}: ${String(error)}`);
    }
}

export function loadHistorySnapshot(dir: string, baseLabel: string): HistorySnapshot {
    return {
        baseLabel,
        inventoryText: readIncidentFile(dir, "source-inventory.json"),
        catalogText: readIncidentFile(dir, "catalog.json"),
        adjudicationLines: splitLedgerLines(readIncidentFile(dir, "adjudications.jsonl")),
        redactionLines: splitLedgerLines(readIncidentFile(dir, "emergency-redactions.jsonl")),
    };
}

export function validateIncidentDirectory(dir: string = INCIDENTS_DIR): IncidentHistoryState {
    return validateIncidentHistory(loadHistorySnapshot(dir, "working"));
}

export function validateAgainstAcceptedDirectory(
    acceptedDir: string,
    baseLabel: string,
    candidateDir: string = INCIDENTS_DIR,
): IncidentHistoryState {
    const accepted = loadHistorySnapshot(acceptedDir, baseLabel);
    const candidate = loadHistorySnapshot(candidateDir, baseLabel);
    return compareWithAcceptedSnapshot(accepted, candidate).candidate;
}

interface CliArgs {
    dir: string;
    accepted: string | null;
    base: string;
}

function parseArgs(args: string[]): CliArgs {
    let dir = INCIDENTS_DIR;
    let accepted: string | null = null;
    let base = "accepted";
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--dir") {
            const value = args[++index];
            if (!value) throw new Error("--dir requires a directory");
            dir = resolve(value);
        } else if (arg === "--accepted") {
            const value = args[++index];
            if (!value) throw new Error("--accepted requires a directory");
            accepted = resolve(value);
        } else if (arg === "--base") {
            const value = args[++index];
            if (!value) throw new Error("--base requires a label");
            base = value;
        } else if (arg === "--help" || arg === "-h") {
            console.log(
                "Usage: validate-incident-history.ts [--dir <incidents-dir>] [--accepted <snapshot-dir>] [--base <label>]",
            );
            process.exit(0);
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    return { dir, accepted, base };
}

if (import.meta.main) {
    try {
        const { dir, accepted, base } = parseArgs(Bun.argv.slice(2));
        const state = accepted
            ? validateAgainstAcceptedDirectory(accepted, base, dir)
            : validateIncidentDirectory(dir);
        const claims = state.inventory.items.reduce((total, item) => total + item.claims.length, 0);
        const variants = state.catalog.families.reduce((total, family) => total + family.variants.length, 0);
        console.log(
            `validated incident history: ${state.inventory.items.length} source items, ${claims} claims, ` +
                `${state.catalog.families.length} families, ${variants} variants, ` +
                `${state.events.length} adjudications, ${state.redactions.length} redactions` +
                (accepted ? " (accepted-snapshot comparison passed)" : ""),
        );
    } catch (error) {
        console.error(`incident history validation failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
