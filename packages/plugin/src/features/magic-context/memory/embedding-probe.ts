/**
 *
 */

export type EmbeddingProbeOutcome =
    | { kind: "ok"; status: number; dimensions: number | null }
    | { kind: "auth_failed"; status: number; preview: string }
    | { kind: "endpoint_unsupported"; status: number; preview: string }
    | { kind: "http_error"; status: number; preview: string }
    | { kind: "network_error"; message: string }
    | { kind: "timeout"; timeoutMs: number }
    | { kind: "invalid_scheme"; endpoint: string };

export interface EmbeddingProbeOptions {
    /**
     */
    endpoint: string;
    model: string;
    apiKey?: string;
    /**
     * */
    inputType?: string;
    /* */
    truncate?: string;
    /* */
    timeoutMs?: number;
    /**
     */
    fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PREVIEW_CHARS = 240;

/**
 *
 */
export async function probeEmbeddingEndpoint(
    options: EmbeddingProbeOptions,
): Promise<EmbeddingProbeOutcome> {
    const endpoint = options.endpoint.trim().replace(/\/+$/, "");
    if (!endpoint) {
        return { kind: "invalid_scheme", endpoint: options.endpoint };
    }
    if (!endpoint.startsWith("https://") && !endpoint.startsWith("http://")) {
        return { kind: "invalid_scheme", endpoint: options.endpoint };
    }

    const fetchImpl = options.fetch ?? fetch;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const url = `${endpoint}/embeddings`;

    const apiKey = options.apiKey?.trim();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) {
        headers.authorization = `Bearer ${apiKey}`;
    }

    const inputType = options.inputType?.trim();
    const truncateMode = options.truncate?.trim();
    const body = JSON.stringify({
        model: options.model,
        input: "magic-context probe",
        ...(inputType ? { input_type: inputType } : {}),
        ...(truncateMode ? { truncate: truncateMode } : {}),
    });

    let response: Response;
    try {
        response = await fetchImpl(url, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
            return { kind: "timeout", timeoutMs };
        }
        // Older runtimes raise `AbortError` instead of `TimeoutError` for `AbortSignal.timeout()`.
        if (error instanceof Error && error.name === "AbortError") {
            return { kind: "timeout", timeoutMs };
        }
        return {
            kind: "network_error",
            message: error instanceof Error ? error.message : String(error),
        };
    }

    const status = response.status;

    if (response.ok) {
        let parsed: unknown = null;
        try {
            parsed = await response.json();
        } catch {
            return { kind: "endpoint_unsupported", status, preview: "" };
        }

        const dimensions = extractDimensions(parsed);
        if (dimensions === null) {
            return {
                kind: "endpoint_unsupported",
                status,
                preview: await readPreview(parsed),
            };
        }
        return { kind: "ok", status, dimensions };
    }

    const preview = await previewErrorBody(response);

    if (status === 401 || status === 403) {
        return { kind: "auth_failed", status, preview };
    }
    if (status === 404 || status === 405) {
        return { kind: "endpoint_unsupported", status, preview };
    }
    return { kind: "http_error", status, preview };
}

function extractDimensions(body: unknown): number | null {
    if (!body || typeof body !== "object") return null;
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length === 0) return null;
    const first = data[0];
    if (!first || typeof first !== "object") return null;
    const embedding = (first as { embedding?: unknown }).embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) return null;
    // The probe rejects a non-finite first entry because dimensions alone could accept a malformed embedding.
    const sample = embedding[0];
    if (typeof sample !== "number" || !Number.isFinite(sample)) return null;
    return embedding.length;
}

async function previewErrorBody(response: Response): Promise<string> {
    try {
        const text = await response.text();
        return truncate(text);
    } catch {
        return "";
    }
}

async function readPreview(parsed: unknown): Promise<string> {
    try {
        return truncate(JSON.stringify(parsed));
    } catch {
        return "";
    }
}

function truncate(text: string): string {
    if (text.length <= MAX_PREVIEW_CHARS) return text;
    return `${text.slice(0, MAX_PREVIEW_CHARS)}…`;
}
