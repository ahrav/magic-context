import type { Database } from "../../shared/sqlite";
export declare function saveSourceContent(db: Database, sessionId: string, tagId: number, content: string): void;
export declare function replaceSourceContent(db: Database, sessionId: string, tagId: number, content: string): void;
export declare function getSourceContents(db: Database, sessionId: string, tagIds: number[]): Map<number, string>;
//# sourceMappingURL=storage-source.d.ts.map