import { join } from "node:path";

import { getDataDir } from "../../../shared/data-path";
import { McHostClient } from "../../../shared/mc-host-client";

/** The sole wire-level coupling between standalone smart notes and scheduled wakes. */
export const WAKE_PLANE_CAPABILITY = "wake.create";

export type WakePlaneStatus = "present" | "absent" | "unknown";

const WAKE_PLANE_STATUS_TTL_MS = 5 * 60 * 1_000;
const WAKE_PLANE_HANDSHAKE_TIMEOUT_MS = 2_000;
/** Bounds the catalog request directly; the client default is 30 seconds. */
const WAKE_PLANE_CATALOG_TIMEOUT_MS = 2_000;

type CatalogEntry = { control_ops?: unknown };
type CatalogProbe = () => Promise<readonly CatalogEntry[]>;

interface WakePlaneStatusCache {
    status: WakePlaneStatus;
    expiresAt: number;
}

let cachedStatus: WakePlaneStatusCache | null = null;
let inFlightProbe: Promise<WakePlaneStatus> | null = null;
let catalogProbe: CatalogProbe = probeWakePlaneCatalog;
let now = () => Date.now();

function connectionFile(): string {
    return join(getDataDir(), "cortexkit", "run", "subc-connection.json");
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
 * Discover whether the fleet's scheduled-wake plane owns condition evaluation.
 * Only an affirmative catalog capability disables standalone smart notes; an
 * unreachable daemon and a catalog without the capability remain fail-open.
 */
export async function wakePlaneStatus(): Promise<WakePlaneStatus> {
    const cached = cachedStatus;
    if (cached && now() < cached.expiresAt) return cached.status;
    if (inFlightProbe) return await inFlightProbe;

    const startedAt = now();
    const probe = probeStatus().then((status) => {
        cachedStatus = { status, expiresAt: startedAt + WAKE_PLANE_STATUS_TTL_MS };
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
        now = () => Date.now();
    },
    setCatalogProbe(probe: CatalogProbe): void {
        catalogProbe = probe;
    },
    setNow(clock: () => number): void {
        now = clock;
    },
    ttlMs: WAKE_PLANE_STATUS_TTL_MS,
};
