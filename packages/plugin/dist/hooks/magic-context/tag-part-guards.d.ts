import { stripTagPrefix } from "./tag-content-primitives";
export { stripTagPrefix };
export interface ValidTextPart {
    type: string;
    text: string;
}
export interface ValidToolPart {
    type: string;
    callID: string;
    state: {
        output: string;
        input?: Record<string, unknown>;
    };
}
interface ValidFilePart {
    type: string;
    url: string;
}
export declare function isTextPart(part: unknown): part is ValidTextPart;
export declare function isToolPartWithOutput(part: unknown): part is ValidToolPart;
export declare function isFilePart(part: unknown): part is ValidFilePart;
export declare function buildFileSourceContent(parts: unknown[]): string | null;
//# sourceMappingURL=tag-part-guards.d.ts.map