import type { Database } from "../../../shared/sqlite";
export interface MuralManifestRow {
    projectPath: string;
    image: Buffer;
    contentHash: string;
    renderedAt: number;
    model: string | null;
    memoryIds: string[];
    width: number;
    height: number;
}
export declare function getMural(db: Database, projectPath: string): MuralManifestRow | null;
export declare function upsertMural(db: Database, input: Omit<MuralManifestRow, "projectPath"> & {
    projectPath: string;
}): void;
//# sourceMappingURL=storage-mural.d.ts.map