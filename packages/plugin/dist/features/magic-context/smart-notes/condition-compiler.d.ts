import type { ProviderConfig } from "@cortexkit/retina-local-fs/provider";
export declare const RETINA_LOCAL_FS_PROVIDER = "local-fs";
export type ConditionCompileResult = {
    status: "compiled";
    provider: typeof RETINA_LOCAL_FS_PROVIDER;
    config: ProviderConfig;
    compiledAt: number;
} | {
    status: "plain";
    reason?: string;
} | {
    status: "refused";
    reason: string;
};
export interface ConditionPathResolution {
    path: string;
    exists: boolean;
}
export interface ConditionCompilerOptions {
    /** Filesystem root used to resolve relative paths and default repository predicates. */
    projectPath: string;
    homeDirectory?: string;
    now?: () => number;
    resolvePath?: (path: string) => Promise<ConditionPathResolution>;
}
/**
 * Compile only the pinned deterministic local-fs phrases. Any prose outside
 * this grammar remains plain so the existing dreamer evaluator keeps custody.
 */
export declare function compileSurfaceCondition(surfaceCondition: string, options: ConditionCompilerOptions): Promise<ConditionCompileResult>;
export declare function conditionCompileStorageFields(result: ConditionCompileResult): {
    compiledProvider: string | null;
    compiledConfig: string | null;
    compiledAt: number | null;
    compileStatus: ConditionCompileResult["status"];
};
export declare function conditionCompileReplySuffix(result: ConditionCompileResult): string;
//# sourceMappingURL=condition-compiler.d.ts.map