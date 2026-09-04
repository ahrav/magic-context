import type { ContextDatabase } from "../../features/magic-context/storage";
import type { Tagger } from "../../features/magic-context/tagger";
type TaggableContentType = "message" | "file";
export interface ExistingTagResolver {
    resolve: (messageId: string, type: TaggableContentType, currentContentId: string, ordinal: number) => number | undefined;
}
export declare function createExistingTagResolver(sessionId: string, tagger: Tagger, db: ContextDatabase): ExistingTagResolver;
export {};
//# sourceMappingURL=tag-id-fallback.d.ts.map