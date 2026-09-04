import { type JSONPath } from "jsonc-parser";
/**
 * Replace one JSONC value without reserializing the rest of the document. New
 * paths use jsonc-parser's structural edit so the original document remains
 * untouched outside the inserted property.
 */
export declare function setJsoncValue(text: string, path: JSONPath, value: unknown): string;
/**
 * Remove matching array entries while retaining the exact bytes for survivor
 * comments and surrounding JSONC regions.
 */
export declare function removeJsoncArrayEntries(text: string, path: JSONPath, shouldRemove: (entry: unknown) => boolean): {
    text: string;
    removed: boolean;
};
/** Append values to an existing JSONC array without reserializing sibling fields. */
export declare function appendJsoncArrayValues(text: string, path: JSONPath, values: unknown[]): string;
//# sourceMappingURL=jsonc-edit.d.ts.map