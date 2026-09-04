import {
  getMagicContextStorageDir
} from "./index-p5d8sma0.js";

// src/shared/announcement.ts
import * as fs from "node:fs";
import * as path from "node:path";

// src/hooks/auto-update-checker/semver.ts
function isValidSemver(version) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}
function compareSemverCore(a, b) {
  if (!isValidSemver(a) || !isValidSemver(b))
    return null;
  const core = (v) => v.split(/[-+]/, 1)[0].split(".").map((n) => Number.parseInt(n, 10));
  const [a0, a1, a2] = core(a);
  const [b0, b1, b2] = core(b);
  return a0 - b0 || a1 - b1 || a2 - b2;
}

// src/shared/announcement.ts
var ANNOUNCEMENT_VERSION = "0.31.0";
var ANNOUNCEMENT_FEATURES = [
  "New /ctx-wrapup command: compact older history on demand, keeping the newest N messages raw. Run it before switching to a smaller-context model.",
  "ctx_search now also searches your session notes and smart notes.",
  "Project identity now survives transient git failures (slow disks, dubious ownership) without splitting your project memory.",
  "Removed the ctx_reduce_enabled setting; agent-controlled reduction is always on. Caveman text compression is now independent (caveman_text_compression.enabled)."
];
var ANNOUNCEMENT_FOOTER = "Join us on Discord: https://discord.gg/F2uWxjGnU";
var STATE_FILENAME = "last_announced_version";
function getStateFilePath() {
  return path.join(getMagicContextStorageDir(), STATE_FILENAME);
}
function readAnnouncementState() {
  try {
    const file = getStateFilePath();
    if (!fs.existsSync(file))
      return { status: "missing" };
    const version = fs.readFileSync(file, "utf-8").trim();
    if (!version)
      return { status: "error" };
    return { status: "valid", version };
  } catch {
    return { status: "error" };
  }
}
function readLastAnnouncedVersion() {
  const state = readAnnouncementState();
  return state.status === "valid" ? state.version : "";
}
function markAnnouncementSeen(version) {
  if (!version)
    return;
  try {
    const dir = getMagicContextStorageDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getStateFilePath(), version);
  } catch {}
}
function shouldShowAnnouncement() {
  if (!ANNOUNCEMENT_VERSION || ANNOUNCEMENT_FEATURES.length === 0)
    return false;
  const state = readAnnouncementState();
  if (state.status === "missing") {
    markAnnouncementSeen(ANNOUNCEMENT_VERSION);
    return false;
  }
  if (state.status === "error") {
    return false;
  }
  const ordering = compareSemverCore(ANNOUNCEMENT_VERSION, state.version);
  if (ordering === null) {
    return state.version !== ANNOUNCEMENT_VERSION;
  }
  return ordering > 0;
}

export { isValidSemver, compareSemverCore, ANNOUNCEMENT_VERSION, ANNOUNCEMENT_FEATURES, ANNOUNCEMENT_FOOTER, readLastAnnouncedVersion, markAnnouncementSeen, shouldShowAnnouncement };
