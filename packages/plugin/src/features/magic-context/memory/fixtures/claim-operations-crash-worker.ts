import { readSync, writeSync } from "node:fs";
import { Database } from "../../../../shared/sqlite.ts";
import { openDatabase } from "../../storage-db.ts";
import { computeClaimOperationRequestDigest } from "../claim-operation-contract.ts";
import {
    runClaimOperation,
    stageCreateProjectMemoryClaimInCurrentTransaction,
} from "../storage-claim-operations.ts";
import { resolveProjectId } from "../storage-claims.ts";

const [, , command, dbPath, siteArg] = process.argv;
if (!command || !dbPath) {
    throw new Error("usage: claim-operations-crash-worker <command> <db> [site]");
}

const PREFIX = "CLAIM_OPERATION_CRASH ";
const PROJECT = "git:u8-claim-operation-crash";
const PRODUCER = "u8-claim-operation-crash";
const OPERATION_KEY = "create-direct-claim-v1";
const NOW_MS = 1_777_777_777_000;
const REQUEST = {
    operation: "create-project-memory-claim",
    project: PROJECT,
    content: "U8 process-crash direct claim",
};

function message(event: string, extra: Record<string, unknown> = {}): void {
    writeSync(1, `${PREFIX}${JSON.stringify({ event, ...extra })}\n`);
}

function blockAt(site: string): void {
    if (siteArg !== site) return;
    message("reached", { site });
    const input = Buffer.alloc(8);
    const bytes = readSync(0, input, 0, input.length, null);
    if (input.subarray(0, bytes).toString("utf8").trim() !== "arm") {
        throw new Error(`invalid supervisor action at ${site}`);
    }
    message("armed", { site });
    readSync(0, input, 0, input.length, null);
    throw new Error(`supervisor closed action pipe at ${site}`);
}

function runBootstrap(): void {
    blockAt("bootstrap.before-open");
    const db = openDatabase(dbPath);
    if (!db) throw new Error("direct bootstrap was refused");
    const marker = db
        .prepare("SELECT database_incarnation_id AS incarnation FROM mc_format_marker WHERE id = 1")
        .get() as { incarnation: string };
    blockAt("bootstrap.after-commit-before-ack");
    message("done", { command, incarnation: marker.incarnation });
}

function runOperation(): void {
    const db = new Database(dbPath);
    try {
        db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL");
        const projectId = resolveProjectId(db, PROJECT);
        if (projectId === null) throw new Error(`missing crash fixture project ${PROJECT}`);
        const result = runClaimOperation(
            db,
            {
                producer: PRODUCER,
                operationKey: OPERATION_KEY,
                requestDigest: computeClaimOperationRequestDigest(REQUEST),
            },
            () => {
                blockAt("operation.before-stage");
                const staged = stageCreateProjectMemoryClaimInCurrentTransaction(
                    db,
                    {
                        projectId,
                        content: REQUEST.content,
                        category: "CONSTRAINTS",
                        provenance: {
                            sourceLocator: "test://u8/process-crash",
                            sourceContent: REQUEST.content,
                            extractor: "u8-crash-worker",
                            extractorVersion: "1",
                            extractorRunId: OPERATION_KEY,
                            independenceKey: OPERATION_KEY,
                            sourceTrustClass: "explicit_user",
                        },
                        actor: "test:u8-crash-worker",
                        requestScope: PROJECT,
                        nowMs: NOW_MS,
                    },
                    NOW_MS,
                );
                blockAt("operation.after-stage");
                return staged;
            },
            NOW_MS,
        );
        blockAt("operation.after-commit-before-ack");
        message("done", {
            command,
            outcome: result.outcome,
            replayed: result.replayed,
            resultJson: result.resultJson,
        });
    } finally {
        db.close();
    }
}

if (command === "bootstrap" || command === "bootstrap-recover") runBootstrap();
else if (command === "operation" || command === "operation-recover") runOperation();
else throw new Error(`unknown command: ${command}`);
