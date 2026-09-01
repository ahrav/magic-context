import { createHash } from "node:crypto";

export function normalizeMemoryContent(content: string): string {
    return content.toLowerCase().replace(/\s+/g, " ").trim();
}

export function computeNormalizedHash(content: string): string {
    const normalized = normalizeMemoryContent(content);
    return createHash("md5").update(normalized).digest("hex");
}
