import type { PromptIO } from "./prompts";

/** Compact filesystem-safe timestamp used in maintenance artifact names. */
export function timestamp(date: Date): string {
    return date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
}

/**
 * Shared refusal report for maintenance commands that must not touch a live
 * database: the headline names the refused action; the holder/uncertainty
 * lines and the retry instruction are identical across commands.
 */
export function reportDatabaseHolderRefusal(
    prompts: PromptIO,
    headline: string,
    inspection: { blockers: string[]; uncertainty?: string },
): void {
    prompts.log.error(headline);
    if (inspection.blockers.length > 0) {
        prompts.log.error(`Active database holder(s): ${inspection.blockers.join(", ")}`);
    }
    if (inspection.uncertainty) prompts.log.error(inspection.uncertainty);
    prompts.log.info("Close every OpenCode, Pi, and OMP process, then run the command again.");
}
