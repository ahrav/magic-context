import { type SmartNoteResolver } from "./ssrf-guard";
export interface SmartNoteCapabilityApi {
    readFile(repoRelativePath: string): Promise<string | null>;
    gitHeadSha(): Promise<string | null>;
    gitTag(): Promise<string | null>;
    gitLog(opts?: {
        maxCount?: number;
        path?: string;
        since?: string;
    }): Promise<Array<{
        sha: string;
        subject: string;
        authorDate: string;
    }>>;
    httpGet(url: string): Promise<{
        status: number;
        body: string;
    }>;
}
export type SmartNoteCapabilityFactory = (signal: AbortSignal) => SmartNoteCapabilityApi;
export interface SmartNoteCapabilitiesOptions {
    projectRoot: string;
    signal: AbortSignal;
    fileLimitBytes?: number;
    resolver?: SmartNoteResolver;
}
export declare function createSmartNoteCapabilities(options: SmartNoteCapabilitiesOptions): SmartNoteCapabilityApi;
export declare function isSecretDeniedPath(repoRelativePath: string): boolean;
export declare function normalizeRepoPath(repoRelativePath: string): string;
//# sourceMappingURL=capabilities.d.ts.map