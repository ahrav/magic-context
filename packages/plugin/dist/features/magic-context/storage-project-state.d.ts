import type { Database } from "../../shared/sqlite";
export declare const GLOBAL_USER_PROFILE_PROJECT_PATH = "__global__";
export interface ProjectStateRow {
    projectPath: string;
    projectMemoryEpoch: number;
    projectUserProfileVersion: number;
    updatedAt: number;
}
export declare function getProjectState(db: Database, projectPath: string): ProjectStateRow | null;
export declare function ensureProjectState(db: Database, projectPath: string, now?: number): ProjectStateRow;
export declare function bumpProjectMemoryEpoch(db: Database, projectPath: string, now?: number): ProjectStateRow;
export declare function bumpProjectUserProfileVersion(db: Database, projectPath?: string, now?: number): ProjectStateRow;
export declare function setProjectState(db: Database, projectPath: string, updates: {
    projectMemoryEpoch?: number;
    projectUserProfileVersion?: number;
    updatedAt?: number;
}): ProjectStateRow;
export declare function deleteProjectState(db: Database, projectPath: string): boolean;
//# sourceMappingURL=storage-project-state.d.ts.map