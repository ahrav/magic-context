/** The sole wire-level coupling between standalone smart notes and scheduled wakes. */
export declare const WAKE_PLANE_CAPABILITY = "wake.create";
export type WakePlaneStatus = "present" | "absent" | "unknown";
type CatalogEntry = {
    control_ops?: unknown;
};
type CatalogProbe = () => Promise<readonly CatalogEntry[]>;
type PublicationReader = () => string | null;
declare function connectionFile(): string;
/**
 * Discover whether the fleet's scheduled-wake plane owns condition evaluation.
 * Only an affirmative catalog capability disables standalone smart notes; an
 * unreachable daemon and a catalog without the capability remain fail-open.
 */
export declare function wakePlaneStatus(): Promise<WakePlaneStatus>;
export declare const __wakePlaneTest: {
    reset(): void;
    setCatalogProbe(probe: CatalogProbe): void;
    setPublicationReader(reader: PublicationReader): void;
    setNow(clock: () => number): void;
    connectionFile: typeof connectionFile;
    ttlMs: number;
};
export {};
//# sourceMappingURL=wake-plane.d.ts.map