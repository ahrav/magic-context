import type { BuiltinCommandConfig } from "./types";

const COMPACTION_ENABLED_PATH = `compaction${".enabled"}`;

export function getMagicContextBuiltinCommands(compactionEnabled = true): BuiltinCommandConfig {
    const unavailableInCompactionOff = (command: string) =>
        `Unavailable when ${COMPACTION_ENABLED_PATH} is false: /${command} manages compacted history.`;

    return {
        "ctx-status": {
            template: "ctx-status",
            description: "Show magic context status, pending queue, cache TTL, and debug info",
        },
        "ctx-recomp": {
            template: "ctx-recomp",
            description: compactionEnabled
                ? "Rebuild compartments and facts from raw history (full or <start>-<end> range)"
                : unavailableInCompactionOff("ctx-recomp"),
        },
        "ctx-wrapup": {
            template: "ctx-wrapup",
            description: compactionEnabled
                ? "Compact older live history while keeping the newest messages raw"
                : unavailableInCompactionOff("ctx-wrapup"),
        },
        "ctx-session-upgrade": {
            template: "ctx-session-upgrade",
            description:
                "Upgrade this session to the latest history format: rebuild compartments and migrate project memories",
        },
        "ctx-flush": {
            template: "ctx-flush",
            description: compactionEnabled
                ? "Force-process all pending magic context operations immediately"
                : unavailableInCompactionOff("ctx-flush"),
        },
        "ctx-aug": {
            template: "ctx-aug",
            description: "Augment your prompt with project memory context via sidekick agent",
        },
        "ctx-dream": {
            template: "ctx-dream",
            description: "Run the hidden dreamer maintenance pass for this project now",
        },
        "ctx-embed": {
            template: "ctx-embed",
            description:
                "Embedding status, or start/pause history compartment embedding (start | pause)",
        },
        "ctx-approve": {
            template: "ctx-approve",
            description:
                "Approve (or --revoke) the exact current revision of a project memory claim",
        },
        "ctx-enforce": {
            template: "ctx-enforce",
            description:
                "Bind a passing in-project artifact to an approved memory claim (ENFORCED)",
        },
    };
}
