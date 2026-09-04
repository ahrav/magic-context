// src/shared/harness.ts
var currentHarness = "opencode";
function getHarness() {
  return currentHarness;
}

// src/shared/data-path.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
function getDataDir() {
  return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}
function getMagicContextTempDir(harness = getHarness()) {
  return path.join(os.tmpdir(), harness, "magic-context");
}
function getMagicContextLogPath(harness = getHarness()) {
  const envPath = process.env.MAGIC_CONTEXT_LOG_PATH?.trim();
  if (envPath)
    return envPath;
  return path.join(getMagicContextTempDir(harness), "magic-context.log");
}
function getProjectMagicContextDir(directory) {
  return path.join(directory, ".cortexkit", "magic-context");
}
var GITIGNORE_GUARD_OPEN = "# >>> cortexkit:magic-context";
var GITIGNORE_GUARD_CLOSE = "# <<< cortexkit:magic-context";
function ensureCortexKitArtifactGitignore(directory) {
  try {
    const cortexKitDir = path.join(directory, ".cortexkit");
    const gitignorePath = path.join(cortexKitDir, ".gitignore");
    let existing = "";
    if (existsSync(gitignorePath)) {
      existing = readFileSync(gitignorePath, "utf8");
      if (existing.includes(GITIGNORE_GUARD_OPEN))
        return;
    }
    const block = `${GITIGNORE_GUARD_OPEN}
magic-context/
${GITIGNORE_GUARD_CLOSE}
`;
    const needsLeadingNewline = existing.length > 0 && !existing.endsWith(`
`);
    const next = existing + (needsLeadingNewline ? `
` : "") + block;
    mkdirSync(cortexKitDir, { recursive: true });
    writeFileSync(gitignorePath, next, "utf8");
  } catch {}
}
function getProjectMagicContextHistorianDir(directory) {
  return path.join(getProjectMagicContextDir(directory), "historian");
}
function getOpenCodeStorageDir() {
  return path.join(getDataDir(), "opencode", "storage");
}
function getMagicContextStorageDir() {
  if (!process.env.XDG_DATA_HOME) {
    const testDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    if (testDataDir) {
      return path.join(testDataDir, "cortexkit", "magic-context");
    }
    if (false) {}
  }
  return path.join(getDataDir(), "cortexkit", "magic-context");
}
var testBackstopDataRoot = null;
var testBackstopWarned = false;
function getTestBackstopDataRoot() {
  if (!testBackstopDataRoot) {
    testBackstopDataRoot = mkdtempSync(path.join(os.tmpdir(), "mc-test-db-backstop-"));
  }
  if (!testBackstopWarned) {
    testBackstopWarned = true;
    console.warn("[magic-context] TEST BACKSTOP: NODE_ENV=test with no MAGIC_CONTEXT_TEST_DATA_DIR " + `— redirecting storage to a throwaway temp dir (${testBackstopDataRoot}) so no ` + "test can touch the user's real shared database or daemon state. Wire " + "`[test] preload` in this package's bunfig.toml.");
  }
  return testBackstopDataRoot;
}

export { getHarness, getDataDir, getMagicContextLogPath, ensureCortexKitArtifactGitignore, getProjectMagicContextHistorianDir, getOpenCodeStorageDir, getMagicContextStorageDir, getTestBackstopDataRoot };
