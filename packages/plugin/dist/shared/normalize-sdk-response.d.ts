export interface NormalizeSDKResponseOptions {
    preferResponseOnMissingData?: boolean;
}
export declare function normalizeSDKResponse<TData>(response: unknown, fallback: TData, options?: NormalizeSDKResponseOptions): TData;
//# sourceMappingURL=normalize-sdk-response.d.ts.map