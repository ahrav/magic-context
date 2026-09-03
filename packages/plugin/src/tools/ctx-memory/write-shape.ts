/**
 * Shape rules shared by every `ctx_memory` write path: a create or revise
 * either carries positive content under a taxonomy category or an anti-memory
 * payload under the anti-memory category, never both.
 */

import { ClaimOperationInputError } from "../../features/magic-context/memory/claim-operation-contract";
import {
    ANTI_MEMORY_CATEGORY,
    WRITABLE_MEMORY_CATEGORIES,
} from "../../features/magic-context/memory/constants";
import type { CtxMemoryAction } from "./types";

export interface CtxMemoryWriteShape {
    action?: CtxMemoryAction;
    content?: string;
    category?: string;
    antiMemory?: unknown;
}

export function requireTaxonomyCategory(category: string | undefined): string | undefined {
    if (category === undefined || category === "") return undefined;
    if (!(WRITABLE_MEMORY_CATEGORIES as readonly string[]).includes(category)) {
        throw new ClaimOperationInputError(
            `unknown claim category: ${category} (expected one of ${WRITABLE_MEMORY_CATEGORIES.join(", ")})`,
        );
    }
    return category;
}

export function assertCtxMemoryWriteShape(args: CtxMemoryWriteShape): void {
    if (args.action !== "create" && args.action !== "revise") return;
    const category = requireTaxonomyCategory(args.category?.trim());
    const antiArm = category === ANTI_MEMORY_CATEGORY || args.antiMemory !== undefined;
    if (antiArm) {
        if (category !== ANTI_MEMORY_CATEGORY || !args.antiMemory || args.content !== undefined) {
            throw new ClaimOperationInputError(
                `${args.action} anti-memory requires category ${ANTI_MEMORY_CATEGORY}, antiMemory payload, and no content`,
            );
        }
        return;
    }
    if (args.antiMemory !== undefined) {
        throw new ClaimOperationInputError(
            `${args.action} positive memory cannot carry antiMemory`,
        );
    }
    if (args.action === "create" && (!category || !args.content?.trim())) {
        throw new ClaimOperationInputError("create requires non-empty content and category");
    }
}
