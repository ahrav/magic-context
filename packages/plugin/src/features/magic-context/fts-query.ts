/**
 * FTS5 interprets characters like `-`, `:`, `*`, `(`, `)` as query operators.
 * Quoted tokens make FTS5 operators literal content.
 */
export function sanitizeFtsQuery(query: string): string {
    const tokens = query.split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length === 0) return "";

    return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" ");
}
