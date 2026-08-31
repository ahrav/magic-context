import { statSync } from "node:fs";
import { getDataDir } from "../../../shared/data-path";
import { McHostClient } from "../../../shared/mc-host-client";
import { defaultConnectionFilePath } from "../../../shared/mc-host-lifecycle/paths";

/** `wake.create` indicates that scheduled wakes own condition evaluation. */
export const WAKE_PLANE_CAPABILITY = "wake.create";

export type WakePlaneStatus = "present" | "absent" | "unknown";

const WAKE_PLANE_STATUS_TTL_MS = 5 * 60 * 1_000;
const WAKE_PLANE_HANDSHAKE_TIMEOUT_MS = 2_000;
/* */
const WAKE_PLANE_CATALOG_TIMEOUT_MS = 2_000;

type CatalogEntry = { control_ops?: unknown };
type CatalogProbe = () => Promise<readonly CatalogEntry[]>;
type PublicationReader = () => string | null;

interface WakePlaneStatusCache {
    status: WakePlaneStatus;
    expiresAt: number;
    /** The cache records the publication against which the answer was proved; `null` means none was readable. */
    publication: string | null;
}

let cachedStatus: WakePlaneStatusCache | null = null;
let inFlightProbe: Promise<WakePlaneStatus> | null = null;
let catalogProbe: CatalogProbe = probeWakePlaneCatalog;
let readPublication: PublicationReader = readDaemonPublication;
let now = () => Date.now();

function connectionFile(): string {
    return defaultConnectionFilePath(getDataDir());
}

/**
 * The publication fingerprint identifies the daemon publication against which the answer was proved.
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
        // Connection and catalog failures return `unknown` so standalone smart notes remain on.
        return "unknown";
    }
}

/**
 * An affirmative answer is reusable only while its daemon retains the publication.
 */
function isRetainedAnswerUsable(cache: WakePlaneStatusCache): boolean {
    // `present` with no readable publication is never reusable.
    if (cache.status === "present" && cache.publication === null) return false;
    return cache.publication === readPublication();
}

/**
 * The status probe determines whether scheduled wakes own condition evaluation.
 * Only an affirmative catalog capability disables standalone smart notes.
 * An unreachable daemon or a catalog without `wake.create` leaves standalone smart notes enabled.
 */
export async function wakePlaneStatus(): Promise<WakePlaneStatus> {
    const cached = cachedStatus;
    if (cached && now() < cached.expiresAt && isRetainedAnswerUsable(cached)) return cached.status;
    if (inFlightProbe) return await inFlightProbe;

    const startedAt = now();
    // The pre-probe publication binds the result to the daemon observed before probing.
    // produced it.
    const publication = readPublication();
    const probe = probeStatus().then((status) => {
        // Stale publications must be rejected before the probe settles so coalesced callers cannot receive stale results.
        // A stale result can describe a daemon that no longer serves requests.
        // After a restart, a stale result can report `present` for the old daemon.
        // A replacement daemon without `wake.create` makes an old `present` result stale.
        //
        // The function returns `unknown` because the result cannot be bound to a publication.
        if (readPublication() !== publication) {
            cachedStatus = null;
            return "unknown" as WakePlaneStatus;
        }
        // The cache does not retain `present` when `publication` is `null` because no daemon identity is available.
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
