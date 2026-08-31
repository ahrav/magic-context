//
//
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isolatedDataHome = mkdtempSync(join(tmpdir(), "mc-plugin-test-xdg-"));

// MAGIC_CONTEXT_TEST_DATA_DIR remains set when tests delete XDG_DATA_HOME.
process.env.MAGIC_CONTEXT_TEST_DATA_DIR = isolatedDataHome;
process.env.XDG_DATA_HOME = isolatedDataHome;
