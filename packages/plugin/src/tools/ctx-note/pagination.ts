import type { Note } from "../../features/magic-context/storage";

/** Default page size for read. Long-running sessions accumulate hundreds of
 *  notes; dumping all of them burns output tokens and buries the recent ones,
 *  so read pages newest-first and tells the caller how to reach older pages. */
export const DEFAULT_READ_LIMIT = 25;

export function paginateNewestFirst(
    notes: Note[],
    limit: number,
    offset: number,
): { page: Note[]; total: number; footer: string | null } {
    const total = notes.length;
    const newestFirst = [...notes].reverse();
    const page = newestFirst.slice(offset, offset + limit);
    const remaining = total - offset - page.length;
    const footer =
        remaining > 0
            ? `Showing ${page.length} of ${total} (newest first) — ${remaining} older: ctx_note(action="read", offset=${offset + page.length})`
            : null;
    return { page, total, footer };
}

export function anchorSuffix(note: Note): string {
    return note.anchorOrdinal !== null ? ` ↳ @msg ${note.anchorOrdinal}` : "";
}
