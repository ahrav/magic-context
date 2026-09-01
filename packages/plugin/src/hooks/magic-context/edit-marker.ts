//
//
// Repeated calls do not further truncate diff values ending in `TRUNCATION_SENTINEL`.

const TRUNCATION_SENTINEL = "...[truncated]";

/* */
export const EDIT_REGION_HINT_LEN = 40;

/* */
const PATH_KEYS = new Set(["filePath", "file_path", "path"]);

/**
 * */
const DIFF_KEYS = new Set(["oldString", "newString", "content", "old_string", "new_string"]);

/** `safeSlice` avoids splitting surrogate pairs.
 * */
function safeSlice(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    const lastCharCode = str.charCodeAt(maxLen - 1);
    if (lastCharCode >= 0xd800 && lastCharCode <= 0xdbff) {
        return str.slice(0, maxLen - 1);
    }
    return str.slice(0, maxLen);
}

/* */
export function isEditTool(name: string | null | undefined): boolean {
    return name === "edit" || name === "write";
}

/**
 * Repeated calls do not further truncate diff values ending in `TRUNCATION_SENTINEL`.
 */
export function applyEditMarkerToInput(input: Record<string, unknown>): void {
    for (const key of Object.keys(input)) {
        if (PATH_KEYS.has(key)) continue;
        const value = input[key];
        if (typeof value !== "string" || !DIFF_KEYS.has(key)) continue;
        if (value.endsWith(TRUNCATION_SENTINEL)) continue; // already a hint
        input[key] =
            value.length > EDIT_REGION_HINT_LEN
                ? `${safeSlice(value, EDIT_REGION_HINT_LEN)}${TRUNCATION_SENTINEL}`
                : value;
    }
}
