import {
    renderClaimMemoryBlock,
    trimClaimSnapshotsToBudget,
} from "../../features/magic-context/memory/claim-memory-render";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { extractM0Block } from "./decay-render";
import { readProjectClaimLaneSnapshot } from "./inject-compartments";
import { estimateTokens } from "./read-session-formatting";

/**
 *
 *
 */
export interface M0BlockTokens {
    docsTokens: number;
    profileTokens: number;
    memoryTokens: number;
    /* */
    muralTokens: number;
    compartmentTokens: number;
    /* */
    factTokens: number;
}

export function computeM0BlockTokens(
    db: ContextDatabase,
    sessionId: string,
    args: {
        m0Text: string;
        projectIdentity: string | undefined;
        injectionBudgetTokens: number | undefined;
        memoryBlockCount: number;
        /* */
        compartmentTokensOverride?: number;
    },
): M0BlockTokens {
    const { m0Text, projectIdentity, injectionBudgetTokens, compartmentTokensOverride } = args;

    const docsBlock = extractM0Block(m0Text, "project-docs");
    const docsTokens = docsBlock ? estimateTokens(docsBlock) : 0;

    const profileBlock = extractM0Block(m0Text, "user-profile");
    const profileTokens = profileBlock ? estimateTokens(profileBlock) : 0;

    const memoryBlock = extractM0Block(m0Text, "project-memory");
    let memoryTokens = memoryBlock ? estimateTokens(memoryBlock) : 0;
    if (!memoryBlock && projectIdentity) {
        try {
            const snapshot = readProjectClaimLaneSnapshot(db, projectIdentity);
            if (snapshot) {
                const selected = trimClaimSnapshotsToBudget(
                    snapshot.items,
                    injectionBudgetTokens ?? 8_000,
                    { sourceNameByClaimId: snapshot.sourceNameByClaimId },
                ).selected;
                const rendered = renderClaimMemoryBlock(selected, "project-memory", {
                    sourceNameByClaimId: snapshot.sourceNameByClaimId,
                });
                memoryTokens = rendered ? estimateTokens(rendered) : 0;
            }
        } catch {
            memoryTokens = 0;
        }
    }

    const muralTokens = m0Text.includes("<memory-mural>") ? 1_521 : 0;

    let compartmentTokens = 0;
    const historyBlock = extractM0Block(m0Text, "session-history");
    if (
        typeof compartmentTokensOverride === "number" &&
        Number.isFinite(compartmentTokensOverride) &&
        compartmentTokensOverride >= 0
    ) {
        compartmentTokens = compartmentTokensOverride;
    } else if (historyBlock) {
        compartmentTokens = estimateTokens(historyBlock);
    } else {
        try {
            const compRows = db
                .prepare<
                    [string],
                    {
                        content: string;
                        title: string;
                        start_message: number;
                        end_message: number;
                    }
                >(
                    "SELECT content, title, start_message, end_message FROM compartments WHERE session_id = ?",
                )
                .all(sessionId);
            for (const c of compRows) {
                compartmentTokens += estimateTokens(
                    `## ${c.start_message}-${c.end_message} · ${c.title}\n${c.content}\n`,
                );
            }
        } catch {
        }
    }

    return {
        docsTokens,
        profileTokens,
        memoryTokens,
        muralTokens,
        compartmentTokens,
        factTokens: 0,
    };
}
