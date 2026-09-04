import type { Database } from "../../../shared/sqlite";
export declare function getDreamState(db: Database, key: string): string | null;
export declare function setDreamState(db: Database, key: string, value: string): void;
export declare function deleteDreamState(db: Database, key: string): void;
//# sourceMappingURL=storage-dream-state.d.ts.map