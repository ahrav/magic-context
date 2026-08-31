/**
 * */
export function extractCompleteManifestBody(text: string, rootName: string): string {
    const escapedRoot = rootName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rootMatch = new RegExp(
        `<${escapedRoot}\\b[^>]*>([\\s\\S]*?)<\\/${escapedRoot}>`,
        "i",
    ).exec(text);
    if (rootMatch) return rootMatch[1];

    const hasOpenRoot = new RegExp(`<${escapedRoot}\\b`, "i").test(text);
    const hasCloseRoot = new RegExp(`<\\/${escapedRoot}>`, "i").test(text);
    if (hasOpenRoot && !hasCloseRoot) {
        throw new Error(`${rootName} manifest missing closing root tag`);
    }
    throw new Error(`${rootName} manifest missing complete root element`);
}

export function assertNoDuplicateManifestIds(
    ids: readonly (number | string)[],
    rootName: string,
): void {
    const seen = new Set<number | string>();
    for (const id of ids) {
        if (seen.has(id)) throw new Error(`${rootName} manifest contains duplicate id ${id}`);
        seen.add(id);
    }
}

export function assertManifestCoversExactly<T extends number | string>(
    ids: readonly T[],
    expectedIds: ReadonlySet<T>,
    rootName: string,
): void {
    assertNoDuplicateManifestIds(ids, rootName);
    for (const id of ids) {
        if (!expectedIds.has(id)) throw new Error(`${rootName} manifest contains unknown id ${id}`);
    }
    for (const id of expectedIds) {
        if (!ids.includes(id)) throw new Error(`${rootName} manifest missing id ${id}`);
    }
}

const OPEN_TAG_RE = /<([A-Za-z][\w:-]*)\b/;

/**
 * */
export function describeUnrecognizedManifestShape(
    text: string,
    expectedRoot: string,
    expectedEntry: string,
): string {
    const expected = `expected <${expectedRoot}> with <${expectedEntry}> entries`;
    const trimmed = text.trim();

    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        return `JSON ${trimmed.startsWith("[") ? "array" : "object"} unrecognized; ${expected}`;
    }

    const firstTag = OPEN_TAG_RE.exec(trimmed)?.[1];
    if (firstTag && firstTag.toLowerCase() !== expectedRoot.toLowerCase()) {
        return `root <${firstTag}> unrecognized; ${expected}`;
    }

    const escapedRoot = expectedRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bodyMatch = new RegExp(
        `<${escapedRoot}\\b[^>]*>([\\s\\S]*?)<\\/${escapedRoot}>`,
        "i",
    ).exec(text);
    const body = (bodyMatch?.[1] ?? "").trim();
    if (body.startsWith("[") || body.startsWith("{")) {
        return `JSON ${body.startsWith("[") ? "array" : "object"} unrecognized; ${expected}`;
    }
    const innerTag = OPEN_TAG_RE.exec(body)?.[1];
    if (innerTag && innerTag.toLowerCase() !== expectedEntry.toLowerCase()) {
        return `root <${innerTag}> unrecognized; ${expected}`;
    }
    return `parsed zero entries; ${expected}`;
}

/**
 * */
export function assertParsedManifestNonEmpty(
    parsedCount: number,
    expectedCount: number,
    text: string,
    expectedRoot: string,
    expectedEntry: string,
): void {
    if (expectedCount > 0 && parsedCount === 0) {
        throw new Error(describeUnrecognizedManifestShape(text, expectedRoot, expectedEntry));
    }
}
