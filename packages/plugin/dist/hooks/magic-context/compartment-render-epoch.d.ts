export declare const COMPARTMENT_RENDER_EPOCH = "cre2";
export interface CachedM0UpgradeIdentity {
    upgradeState: string | null;
    compartmentRenderEpoch: string | null;
    muralEnabled: boolean | null;
    renderBudgetIdentity: string | null;
}
/**
 * Store renderer and render-config identity in the existing cached upgrade-state marker.
 * Provider-visible byte changes must change this identity so each cached m[0] folds exactly once.
 */
export declare function encodeCachedM0UpgradeIdentity(upgradeState: string | null, compartmentRenderEpoch?: string | null, muralEnabled?: boolean | null, renderBudgetIdentity?: string | null): string | null;
export declare function decodeCachedM0UpgradeIdentity(value: string | null): CachedM0UpgradeIdentity;
//# sourceMappingURL=compartment-render-epoch.d.ts.map