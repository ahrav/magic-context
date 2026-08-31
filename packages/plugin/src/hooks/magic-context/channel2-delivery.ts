//
// The context-reduction transform records a cycle-capped pending intent in session_meta.
// The message.updated handler delivers pending intents on tool-calls and stop events.
// The event handler invokes promptAsync because promptAsync requires an event boundary.
// Subagents deliver only during a live run so a final stop event cannot start a follow-up turn.
// Mid-turn delivery lets the active run consume the queued nudge at its next step boundary.
//
// Cross-process CAS transitions nudge state from pending to claimed(token) to delivered.
// Each sender claims pending state with a unique token before sending to prevent duplicate sends.
// After confirmed delivery, only the claiming token can transition state from claimed to delivered.
//     cycle consumed)
// On send failure, revert claimed state to pending so transient transport failures preserve the nudge.
// After a successful send, never revert the claim to pending because the user message may already exist.
// If a healed stale lease was re-delivered by another process, preserve the authoritative row when token-CAS misses.
//     overwriting it.
//
// On OpenCode >= 1.17.7, `deps.client` routes prompts through the live listener runtime when one exists.
// promptAsync joins the in-flight runner when a live listener runtime exists.
// Routing through the live listener prevents a second runner from persisting a duplicate assistant message.

import { randomUUID } from "node:crypto";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import {
    casChannel2NudgeClaim,
    casChannel2NudgeState,
    claimChannel2NudgeState,
    getChannel2NudgeClaim,
    getChannel2NudgeState,
} from "../../features/magic-context/storage-meta-persisted";
import { sessionLog } from "../../shared/logger";
import { resolvePromptContext } from "../../shared/prompt-context";
import type { Database } from "../../shared/sqlite";
import {
    buildChannel2Reminder,
    type Channel2PredicateBaseline,
    evaluateChannel2,
    type ToolReclaimHint,
} from "./ctx-reduce-nudge";
import { isMidTurn } from "./read-session-db";

export interface Channel2DeliveryDeps {
    db: Database;
    /**
     * Channel 2 sends synthetic ceiling nudges through client.session.promptAsync; delivery is a no-op when client is absent.
     */
    client?: unknown;
    /** `baseline` persists reclaimable and total tail tokens, typed deltas, and generation validity. */
    baseline?: Channel2PredicateBaseline;
    oldestReclaimableToolTags?: readonly ToolReclaimHint[];
    /** Module-owned directives are already predicate-validated; preserve their text verbatim. */
    directiveText?: string;
}

/**
 * Return whether a pending nudge may be delivered to this session.
 *
 * Primary sessions deliver their Channel-2 message at the event boundary even when the assistant has stopped.
 */
function subagentRunIsActive(deps: Channel2DeliveryDeps, sessionId: string): boolean {
    try {
        const meta = getOrCreateSessionMeta(deps.db, sessionId);
        if (!meta.isSubagent) return true;
        return isMidTurn(deps, sessionId);
    } catch (error) {
        sessionLog(
            sessionId,
            "channel2 subagent run-state check failed; refusing delivery:",
            error,
        );
        return false;
    }
}

function clearPendingChannel2Intent(db: Database, sessionId: string): void {
    try {
        if (casChannel2NudgeState(db, sessionId, "pending", "")) {
            sessionLog(sessionId, "channel2 intent cleared because the subagent run is terminal");
        }
    } catch (error) {
        sessionLog(
            sessionId,
            "channel2 terminal-run intent clear failed; leaving lease to heal:",
            error,
        );
    }
}

function releaseClaimWithoutDelivery(db: Database, sessionId: string, claimToken: string): void {
    try {
        if (casChannel2NudgeClaim(db, sessionId, "", claimToken)) {
            sessionLog(
                sessionId,
                "channel2 claim released because the subagent run completed before delivery",
            );
        }
    } catch (error) {
        sessionLog(
            sessionId,
            "channel2 terminal-run claim release failed; lease will heal:",
            error,
        );
    }
}

/**
 * The handler runs on every step-boundary `message.updated` event and no-ops unless a `pending` intent exists and a client is wired.
 * Return true only after the intent transitions to `delivered`.
 * Return true only after the intent transitions to `delivered`.
 */
export async function maybeDeliverChannel2(
    sessionId: string,
    deps: Channel2DeliveryDeps,
): Promise<boolean> {
    let state: string;
    try {
        state = getChannel2NudgeState(deps.db, sessionId);
    } catch {
        return false;
    }
    if (state !== "pending") return false;

    // A terminal subagent must never be re-awakened by a stale pending intent.
    if (!subagentRunIsActive(deps, sessionId)) {
        clearPendingChannel2Intent(deps.db, sessionId);
        return false;
    }

    // Revalidate before delivery because typed mass can change between arming and the next step boundary.
    // Revalidate before delivery because typed mass can change between arming and the next step boundary.
    // A module directive bypasses this TypeScript baseline check and supplies its own text.
    // A module directive bypasses the TypeScript baseline check and preserves its text.
    //
    // An unevaluable baseline leaves `pending`; an evaluated false predicate clears it to `""`.
    // An evaluated false predicate clears `pending` to the re-armable empty state.
    const evaluation = evaluateChannel2(deps.baseline);
    if (deps.directiveText === undefined && !evaluation.evaluable) {
        return false;
    }
    if (deps.directiveText === undefined && !evaluation.shouldTrigger) {
        try {
            casChannel2NudgeState(deps.db, sessionId, "pending", "");
            sessionLog(
                sessionId,
                `channel2 intent cleared pre-delivery (U ${evaluation.reclaimableTokens}, T ${evaluation.tailTokens} — trigger no longer holds; re-armable)`,
            );
        } catch {
            // A later `message.updated` event re-evaluates any intent that remains `pending`.
        }
        return false;
    }
    const effectiveU = evaluation.reclaimableTokens;

    const client = deps.client;
    if (!client) return false;

    // Claim the pending intent before sending so a sibling process cannot send it concurrently.
    // The token makes confirm and revert reject healed stale leases.
    const claimToken = randomUUID();
    if (!claimChannel2NudgeState(deps.db, sessionId, claimToken)) {
        return false;
    }

    // The assistant can finish after the pre-check but before this delivery
    // If the assistant finishes after the pre-check and before the claim is acquired, release only the matching claim without sending.
    // The claimToken prevents release from changing a concurrent claim.
    if (!subagentRunIsActive(deps, sessionId)) {
        releaseClaimWithoutDelivery(deps.db, sessionId, claimToken);
        return false;
    }

    try {
        const promptContext = await resolvePromptContext(client, sessionId);
        // Module directives supply `directiveText`; host-triggered reminders use the measured reclaimable tail.
        const reminder =
            deps.directiveText ?? buildChannel2Reminder(effectiveU, deps.oldestReclaimableToolTags);

        const body: Record<string, unknown> = {
            noReply: false,
            parts: [{ type: "text", text: reminder, synthetic: true }],
        };
        if (promptContext?.agent) body.agent = promptContext.agent;
        if (promptContext?.model) {
            body.model = {
                providerID: promptContext.model.providerID,
                modelID: promptContext.model.modelID,
            };
        }
        if (promptContext?.variant) body.variant = promptContext.variant;

        const session = (client as { session?: { promptAsync?: (i: unknown) => Promise<unknown> } })
            .session;
        if (typeof session?.promptAsync !== "function") {
            throw new Error("client has no session.promptAsync");
        }
        const claim = getChannel2NudgeClaim(deps.db, sessionId);
        if (claim.state !== "claimed" || claim.claimToken !== claimToken) {
            sessionLog(
                sessionId,
                `channel2 ceiling nudge delivery skipped: claim no longer owned before send (state=${claim.state || "empty"})`,
            );
            return false;
        }
        // The code re-checks subagentRunIsActive immediately before promptAsync because resolvePromptContext can yield to the host.
        // A child that completes while its claim is queued must leave its report as the last message rather than start a follow-up turn.
        // A child that completes while its claim is queued must leave its report as the last message rather than start a follow-up turn.
        if (!subagentRunIsActive(deps, sessionId)) {
            releaseClaimWithoutDelivery(deps.db, sessionId, claimToken);
            return false;
        }
        await session.promptAsync({ path: { id: sessionId }, body });
    } catch (error) {
        // synthetic user message may already exist; re-arming can duplicate it.
        try {
            const restored = casChannel2NudgeClaim(deps.db, sessionId, "pending", claimToken);
            if (restored) {
                sessionLog(
                    sessionId,
                    "channel2 ceiling nudge delivery failed (will retry):",
                    error,
                );
            } else {
                sessionLog(
                    sessionId,
                    "channel2 ceiling nudge delivery failed after its claim was no longer owned; lease state left unchanged:",
                    error,
                );
            }
        } catch (revertError) {
            sessionLog(
                sessionId,
                "channel2 ceiling nudge delivery failed; pending restore was busy so the stale claim will heal later:",
                { deliveryError: error, revertError },
            );
        }
        return false;
    }

    try {
        // A successful CAS consumes the current tail-reset cycle.
        // authoritative; a stolen/expired claim must not be treated as delivered.
        const confirmed = casChannel2NudgeClaim(deps.db, sessionId, "delivered", claimToken);
        if (confirmed) {
            sessionLog(sessionId, "channel2 ceiling nudge delivered");
            return true;
        }
        const claim = getChannel2NudgeClaim(deps.db, sessionId);
        sessionLog(
            sessionId,
            `channel2 ceiling nudge sent but claim confirmation was not ours (state=${claim.state || "empty"}); leaving existing lease state unchanged`,
        );
        return false;
    } catch (error) {
        // Do not revert to pending after a post-send DB failure: retrying could send a duplicate ceiling nudge.
        sessionLog(
            sessionId,
            "channel2 ceiling nudge sent but token-confirm failed; lease state left unchanged:",
            error,
        );
        return false;
    }
}
