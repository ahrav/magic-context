import type { ImitatedReducedArgs } from "../unwrap-imitated-reduced-args";

export interface CtxExpandArgs extends ImitatedReducedArgs {
    start?: number;
    end?: number;
    /* */
    verbose?: boolean;
    /* */
    message?: number;
}
