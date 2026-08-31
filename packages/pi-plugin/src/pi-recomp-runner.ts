import {
	type RawMessageProvider,
	setRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { sessionLog } from "@magic-context/core/shared/logger";
import { setMagicContextRecompActive } from "./status-line";

/**
 *
 */
const inFlightRecomp = new Map<string, Promise<unknown>>();

/* */
export function isPiRecompInFlight(sessionId: string): boolean {
	return inFlightRecomp.has(sessionId);
}

/**
 */
export async function awaitInFlightRecomps(): Promise<void> {
	if (inFlightRecomp.size === 0) return;
	await Promise.allSettled(Array.from(inFlightRecomp.values()));
}

/**
 *
 * `spawnPiRecompRun` keeps `provider` registered and magic-context recompilation active until `work` settles.
 * `spawnPiRecompRun` returns before `work()` settles.
 * `work` may reject; `spawnPiRecompRun` logs failures.
 *
 * `unregister` removes only `provider`, preserving a provider registered later for the same session.
 * cleanup.
 */
export function spawnPiRecompRun(args: {
	sessionId: string;
	provider: RawMessageProvider;
	onStatusChange: () => void;
	work: () => Promise<void>;
}): void {
	const { sessionId, provider, onStatusChange, work } = args;
	const unregister = setRawMessageProvider(sessionId, provider);
	setMagicContextRecompActive(sessionId, true);
	onStatusChange();
	const runPromise = (async () => {
		try {
			await work();
		} catch (err) {
			sessionLog(
				sessionId,
				`pi recomp run failed (detached): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	})().finally(() => {
		inFlightRecomp.delete(sessionId);
		setMagicContextRecompActive(sessionId, false);
		unregister();
		onStatusChange();
	});
	inFlightRecomp.set(sessionId, runPromise);
}
