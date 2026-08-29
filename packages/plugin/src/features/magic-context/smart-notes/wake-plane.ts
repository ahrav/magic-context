import { statSync } from "node:fs";
import { getDataDir } from "../../../shared/data-path";
import { McHostClient } from "../../../shared/mc-host-client";
import { defaultConnectionFilePath } from "../../../shared/mc-host-lifecycle/paths";

/** The sole wire-level coupling between standalone smart notes and scheduled wakes. */
export const WAKE_PLANE_CAPABILITY = "wake.create";

export type WakePlaneStatus = "present" | "absent" | "unknown";

const WAKE_PLANE_STATUS_TTL_MS = 5 * 60 * 1_000;
const WAKE_PLANE_HANDSHAKE_TIMEOUT_MS = 2_000;
/** Bounds the catalog request directly; the client default is 30 seconds. */
const WAKE_PLANE_CATALOG_TIMEOUT_MS = 2_000;

type CatalogEntry = { control_ops?: unknown };
type CatalogProbe = () => Promise<readonly CatalogEntry[]>;
type PublicationReader = () => string | null;

interface WakePlaneStatusCache {
    status: WakePlaneStatus;
    expiresAt: number;
    /** Publication the answer was proved against; null when none was readable. */
    publication: string | null;
}

let cachedStatus: WakePlaneStatusCache | null = null;
let inFlightProbe: Promise<WakePlaneStatus> | null = null;
let catalogProbe: CatalogProbe = probeWakePlaneCatalog;
let readPublication: PublicationReader = readDaemonPublication;
let now = () => Date.now();

function connectionFile(): string {
    // The managed lifecycle owner publishes the daemon under the lifecycle data
    // root, and this file is both what the catalog probe dials and what binds a
    // retained answer to its daemon. Both must agree with that resolver, or a
    // managed start publishes somewhere this never reads. The application
    // storage resolver only backstops environments where no lifecycle root
    // resolves at all.
    return defaultConnectionFilePath(getDataDir());
}

/**
 * Identity of the daemon publication an answer was proved against. A daemon
 * replacement republishes this file with a new socket, pid, and auth key, so a
 * change here retires every capability the previous daemon proved.
 */
function readDaemonPublication(): string | null {
    try {
        const stat = statSync(connectionFile());
        return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    } catch {
        return null;
    }
}

async function probeWakePlaneCatalog(): Promise<readonly CatalogEntry[]> {
    const client = await McHostClient.connect({
        connectionFile: connectionFile(),
        handshakeTimeoutMs: WAKE_PLANE_HANDSHAKE_TIMEOUT_MS,
        requestTimeoutMs: WAKE_PLANE_CATALOG_TIMEOUT_MS,
    });
    try {
        return await client.catalogList();
    } finally {
        await client.closeAsync().catch(() => undefined);
    }
}

function catalogHasWakePlane(entries: readonly CatalogEntry[]): boolean {
    return entries.some(
        (entry) =>
            Array.isArray(entry.control_ops) && entry.control_ops.includes(WAKE_PLANE_CAPABILITY),
    );
}

async function probeStatus(): Promise<WakePlaneStatus> {
    try {
        return catalogHasWakePlane(await catalogProbe()) ? "present" : "absent";
    } catch {
        // A reachable catalog is the only proof that scheduled wakes own this
        // capability. Connection and catalog failures must leave smart notes on.
        return "unknown";
    }
}

/**
 * Every retained answer is bound to the daemon publication it was proved
 * against, and the probe closes its connection. An affirmative answer may only
 * be reused while that daemon still owns the publication, so a replacement can
 * never inherit the capability. A negative or unknown answer is bound the same
 * way: under lazy demand-start the common case is a passive probe that runs
 * BEFORE the first Rust or Synapse demand, and the managed start that follows
 * publishes a new connection file. Without this binding that answer would keep
 * standalone evaluation on for the rest of its TTL while the daemon already
 * owns scheduled wakes, so both planes would evaluate the same conditions.
 */
function isRetainedAnswerUsable(cache: WakePlaneStatusCache): boolean {
    // An affirmative answer with no readable publication has nothing that can
    // retire it, so it is never retained in the first place.
    if (cache.status === "present" && cache.publication === null) return false;
    return cache.publication === readPublication();
}

/**
 * Discover whether the fleet's scheduled-wake plane owns condition evaluation.
 * Only an affirmative catalog capability disables standalone smart notes; an
 * unreachable daemon and a catalog without the capability remain fail-open.
 */
export async function wakePlaneStatus(): Promise<WakePlaneStatus> {
    const cached = cachedStatus;
    if (cached && now() < cached.expiresAt && isRetainedAnswerUsable(cached)) return cached.status;
    if (inFlightProbe) return await inFlightProbe;

    const startedAt = now();
    // Captured before the probe: a daemon that republishes while the probe is
    // in flight leaves a stale identity here, which the next read rejects.
    const publication = readPublication();
    const probe = probeStatus().then((status) => {
        // With no readable publication there is nothing to bind an affirmative
        // answer to, so it is not retained at all.
        cachedStatus =
            status === "present" && publication === null
                ? null
                : { status, expiresAt: startedAt + WAKE_PLANE_STATUS_TTL_MS, publication };
        return status;
    });
    inFlightProbe = probe;
    try {
        return await probe;
    } finally {
        if (inFlightProbe === probe) inFlightProbe = null;
    }
}

export const __wakePlaneTest = {
    reset(): void {
        cachedStatus = null;
        inFlightProbe = null;
        catalogProbe = probeWakePlaneCatalog;
        readPublication = readDaemonPublication;
        now = () => Date.now();
    },
    setCatalogProbe(probe: CatalogProbe): void {
        catalogProbe = probe;
    },
    setPublicationReader(reader: PublicationReader): void {
        readPublication = reader;
    },
    setNow(clock: () => number): void {
        now = clock;
    },
    connectionFile,
    ttlMs: WAKE_PLANE_STATUS_TTL_MS,
};
