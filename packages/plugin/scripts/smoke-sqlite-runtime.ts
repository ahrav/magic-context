// The script smoke-tests SQLite runtime gates and direct-format
// classification: off-path source probe, WAL-reset-safety gate, connection
// contract, and the direct test-database factory. Runs under Bun AND Node.
// The .ts import extensions support Node's type-stripping loader.
//   bun packages/plugin/scripts/smoke-sqlite-runtime.ts
//   node packages/plugin/scripts/smoke-sqlite-runtime.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    collectSqliteRuntimeGateInput,
    Database,
    evaluateSqliteRuntimeGate,
    verifySqliteConnectionContract,
} from "../src/shared/sqlite.ts";
import {
    classifyDatabaseFormatFamily,
    inspectDatabaseForClassification,
    readDirectFormatMarker,
} from "../src/features/magic-context/storage-format-epoch.ts";
import {
    computeExpectedDirectFormat,
    createDirectTestDatabase,
} from "../src/features/magic-context/test-database.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    }
}

const gateInput = collectSqliteRuntimeGateInput();
console.log(
    `  runtime=${gateInput.runtime} ${gateInput.runtimeVersion} sqlite=${gateInput.sqliteVersion} source=${gateInput.sqliteSourceId}`,
);
const gate = evaluateSqliteRuntimeGate(gateInput);
check("live runtime passes the WAL-reset-safety gate", gate.ok, gate.reasons.join("; "));

check(
    "gate rejects Node 24.14.1",
    !evaluateSqliteRuntimeGate({ ...gateInput, runtime: "Node.js", runtimeVersion: "24.14.1" }).ok,
);
check(
    "gate rejects a pre-fix SQLite 3.46.0 source",
    !evaluateSqliteRuntimeGate({ ...gateInput, sqliteVersion: "3.46.0" }).ok,
);
check(
    "gate rejects an unknown source identity",
    !evaluateSqliteRuntimeGate({ ...gateInput, sqliteSourceId: "vendor-custom-build" }).ok,
);

const dir = mkdtempSync(join(tmpdir(), "mc-sqlite-runtime-smoke-"));
try {
    const contractPath = join(dir, "contract.db");
    const contractDb = new Database(contractPath);
    contractDb.exec("PRAGMA busy_timeout=5000");
    contractDb.exec("PRAGMA foreign_keys=ON");
    contractDb.exec("PRAGMA journal_mode=WAL");
    const violations = verifySqliteConnectionContract(contractDb, {
        expectWal: true,
        minBusyTimeoutMs: 5000,
    });
    check("connection contract holds after production PRAGMAs", violations.length === 0, violations.join("; "));
    contractDb.exec("PRAGMA foreign_keys=OFF");
    const fkViolations = verifySqliteConnectionContract(contractDb, { expectWal: true });
    check(
        "connection contract flags disabled foreign keys",
        fkViolations.some((violation) => violation.includes("foreign_keys")),
        fkViolations.join("; "),
    );
    contractDb.close();

    const expected = computeExpectedDirectFormat();
    const directPath = join(dir, "direct.db");
    const { db: directDb, marker } = createDirectTestDatabase({ path: directPath });
    const fresh = classifyDatabaseFormatFamily(
        inspectDatabaseForClassification(directDb, directPath),
        expected,
    );
    check("direct factory database classifies as current", fresh.family === "current", JSON.stringify(fresh));
    directDb.close();

    const reopened = new Database(directPath);
    const reread = readDirectFormatMarker(reopened);
    check(
        "database incarnation is stable across reopen",
        reread.status === "present" && reread.marker.databaseIncarnationId === marker.databaseIncarnationId,
        JSON.stringify(reread),
    );
    reopened.close();

    const pristinePath = join(dir, "pristine.db");
    const pristineDb = new Database(pristinePath);
    const pristine = classifyDatabaseFormatFamily(
        inspectDatabaseForClassification(pristineDb, pristinePath),
        expected,
    );
    check("empty file classifies as pristine", pristine.family === "pristine", JSON.stringify(pristine));
    pristineDb.close();
    writeFileSync(`${pristinePath}-wal`, "");
    const pristineDb2 = new Database(pristinePath);
    const orphan = classifyDatabaseFormatFamily(
        inspectDatabaseForClassification(pristineDb2, pristinePath),
        expected,
    );
    check("orphan WAL beside a pristine main refuses bootstrap", orphan.family === "orphan-artifacts", JSON.stringify(orphan));
    pristineDb2.close();

    const legacyPath = join(dir, "legacy.db");
    const legacyDb = new Database(legacyPath);
    legacyDb.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");
    const legacy = classifyDatabaseFormatFamily(
        inspectDatabaseForClassification(legacyDb, legacyPath),
        expected,
    );
    check("legacy migration database refuses as unsupported", legacy.family === "unsupported", JSON.stringify(legacy));
    legacyDb.close();
} finally {
    rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nSMOKE PASS (sqlite runtime gate + direct format)" : `\nSMOKE FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
