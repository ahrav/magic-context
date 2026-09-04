import type { ImitatedReducedArgs } from "../unwrap-imitated-reduced-args";
export interface CtxExpandArgs extends ImitatedReducedArgs {
    start?: number;
    end?: number;
    /** Verbose range view: each message + tool call shown separately, with ordinals. */
    verbose?: boolean;
    /** Full untruncated recovery of one message (any role) by its ordinal. */
    message?: number;
}
//# sourceMappingURL=types.d.ts.map