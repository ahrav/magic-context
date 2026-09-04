import type { Database } from "../../shared/sqlite";
export interface IdentityRekeyMapRow {
    oldProjectPath: string;
    newProjectPath: string;
    rekeyedAt: number;
}
export declare function upsertIdentityRekeyMap(db: Database, oldProjectPath: string, newProjectPath: string, rekeyedAt?: number): IdentityRekeyMapRow;
export declare function getIdentityRekeyMap(db: Database, oldProjectPath: string): IdentityRekeyMapRow | null;
export declare function listIdentityRekeyMaps(db: Database): IdentityRekeyMapRow[];
export declare function deleteIdentityRekeyMap(db: Database, oldProjectPath: string): boolean;
//# sourceMappingURL=storage-identity-rekey-map.d.ts.map