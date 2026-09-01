/**
 * The server emulates Anthropic's Messages API.
 *
 * The server accepts POST requests at `/messages`, matching `@ai-sdk/anthropic`'s `${baseURL}/messages` path.
 * The server captures each request body and returns scripted responses.
 * The mock controls input, output, cache-read, and cache-write token counts.
 *
 * The server supports Anthropic Messages SSE streaming and single-shot JSON responses.
 */

import { fnv1a32 } from "../fnv1a";

export interface MockUsage {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
}

export interface MockResponse {
    /** The mock converts `text` into an Anthropic content array. */
    text?: string;
    /** `content` overrides `text` for tool calls or multiple content blocks. */
    content?: unknown[];
    /* */
    stop_reason?: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
    /**
     * Tests use these counts to exercise token thresholds.
     * `usage` is required unless `error` is set; errors omit usage.
     */
    usage?: MockUsage;
    /* */
    delayMs?: number;
    /** `model` overrides the response model; otherwise the response echoes the request model. */
    model?: string;
    /**
     * `error` returns an error response instead of an assistant message.
     * `error` simulates provider failures such as context overflow, rate limits, and authentication errors.
     * The harness emits Anthropic-shaped error bodies for rate limits and authentication errors.
     * The harness emits an Anthropic-shaped error body with the supplied HTTP status, type, and message.
     * `parseAPICallError` and magic-context's overflow detector match these error bodies.
     */
    error?: {
        /** `status` is the HTTP status code, such as 400 for overflow or 413 for an oversized payload. */
        status: number;
        /** `type` is the Anthropic `error.type` value, such as `invalid_request_error`. */
        type: string;
        /** `message` is regex-matched to detect context overflow. */
        message: string;
    };
}

/**
 */
export interface CapturedEmbeddingRequest {
    receivedAt: number;
    model: string;
    /** `inputType` stores OpenAI-compatible `input_type` values such as `query` or `passage`, or null. */
    inputType: string | null;
    inputs: string[];
}

export const EMBEDDING_DIMENSIONS = 8;

/**
 * Tokens on the same axis produce identical vectors despite zero lexical overlap, allowing semantic-only matches that FTS cannot satisfy.
 * accidentally satisfy.
 */
export const SEMANTIC_MARKER_AXES: readonly (readonly string[])[] = [
    ["aurora", "borealis"],
    ["cascade", "rapids"],
];

/**
 * The embedding is deterministic across processes and runs.
 */
export function deterministicEmbedding(text: string): number[] {
    const tokens = text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 0);
    const vector: number[] = new Array(EMBEDDING_DIMENSIONS).fill(0);
    for (const [axis, markers] of SEMANTIC_MARKER_AXES.entries()) {
        if (tokens.some((token) => markers.includes(token))) vector[axis] += 1;
    }
    if (vector.every((component) => component === 0)) {
        for (const token of tokens) {
            vector[fnv1a32(token) % EMBEDDING_DIMENSIONS] += 1;
        }
    }
    const norm = Math.hypot(...vector) || 1;
    return vector.map((component) => component / norm);
}

export interface CapturedRequest {
    receivedAt: number;
    /** Set when the mock has finished producing the response for this request. */
    responseCompletedAt?: number;
    method: string;
    path: string;
    headers: Record<string, string>;
    body: {
        model?: string;
        messages?: Array<{ role: string; content: unknown }>;
        system?: unknown;
        tools?: unknown;
        [k: string]: unknown;
    };
}

export interface MockServerOptions {
    port?: number;
}

/**
 * Return `null` to skip to the next matcher or the default response.
 *
 * Matchers run in insertion order; the first match wins.
 * If every matcher returns `null`, the provider consults the main queue, then `defaultResponse`.
 *
 */
export type RequestMatcher = (
    body: Record<string, unknown>,
    headers: Record<string, string>,
) => MockResponse | null;

export class MockProvider {
    private server: ReturnType<typeof Bun.serve> | null = null;
    private responses: MockResponse[] = [];
    private captured: CapturedRequest[] = [];
    private capturedEmbeddings: CapturedEmbeddingRequest[] = [];
    private defaultResponse: MockResponse | null = null;
    private matchers: RequestMatcher[] = [];
    private defaultHitCount = 0;

    async start(
        options: MockServerOptions = {},
    ): Promise<{ port: number; baseURL: string }> {
        const port = options.port ?? 0; // 0 = pick any available port
        this.server = Bun.serve({
            port,
            // Bun defaults to `0.0.0.0`; bind `127.0.0.1` to restrict the scripted provider to the local host.
            hostname: "127.0.0.1",
            fetch: async (req) => this.handle(req),
        });
        const actualPort = this.server.port ?? 0;
        if (!actualPort) throw new Error("mock server failed to bind a port");
        return { port: actualPort, baseURL: `http://127.0.0.1:${actualPort}` };
    }

    async stop(): Promise<void> {
        if (this.server) {
            this.server.stop(true);
            this.server = null;
        }
    }

    /* */
    script(responses: MockResponse[]): void {
        this.responses = [...responses];
    }

    /** Set a default response to return when the queue is empty. */
    setDefault(response: MockResponse): void {
        this.defaultResponse = response;
    }

    /* */
    enqueue(response: MockResponse): void {
        this.responses.push(response);
    }

    /**
     * Matchers run in insertion order; the first non-`null` result determines the response.
     * If no matcher returns a response, the provider consults the main queue, then `defaultResponse`.
     */
    addMatcher(matcher: RequestMatcher): void {
        this.matchers.push(matcher);
    }

    /* */
    requests(): CapturedRequest[] {
        return [...this.captured];
    }

    /* */
    lastRequest(): CapturedRequest | null {
        return this.captured[this.captured.length - 1] ?? null;
    }

    /**
     * Embedding requests persist across reset().
     * Provenance must cover both the seed embedding and the post-edit re-embedding.
     */
    embeddingRequests(): CapturedEmbeddingRequest[] {
        return [...this.capturedEmbeddings];
    }

    /* */
    reset(): void {
        this.responses = [];
        this.captured = [];
        this.defaultResponse = null;
        this.matchers = [];
        this.defaultHitCount = 0;
    }

    /**
     * Counts `/messages` requests that fall through matchers and the queue to `defaultResponse`.
     * script drift.
     */
    defaultHits(): number {
        return this.defaultHitCount;
    }

    private async handle(req: Request): Promise<Response> {
        let url: URL;
        try {
            url = new URL(req.url);
        } catch {
            return new Response(
                JSON.stringify({
                    error: "bad_request",
                    message: "invalid request URL",
                }),
                {
                    status: 400,
                    headers: { "content-type": "application/json" },
                },
            );
        }
        const method = req.method;

        const isEmbeddings =
            url.pathname === "/embeddings" || url.pathname === "/v1/embeddings";
        if (method === "POST" && isEmbeddings) {
            let rawBody: unknown;
            try {
                rawBody = await req.json();
            } catch {
                rawBody = null;
            }
            const bodyIsObject =
                rawBody !== null &&
                typeof rawBody === "object" &&
                !Array.isArray(rawBody);
            const body = bodyIsObject
                ? (rawBody as Record<string, unknown>)
                : null;
            const rawInput = body?.input;
            const inputIsValid =
                typeof rawInput === "string" ||
                (Array.isArray(rawInput) &&
                    rawInput.length > 0 &&
                    rawInput.every((entry) => typeof entry === "string"));
            const inputTypeIsValid =
                body !== null &&
                (!("input_type" in body) ||
                    typeof body.input_type === "string");
            if (
                body === null ||
                typeof body.model !== "string" ||
                !inputTypeIsValid ||
                !inputIsValid
            ) {
                return new Response(
                    JSON.stringify({
                        error: "bad_request",
                        message: "invalid embedding request",
                    }),
                    {
                        status: 400,
                        headers: { "content-type": "application/json" },
                    },
                );
            }
            const inputs = Array.isArray(rawInput) ? rawInput : [rawInput];
            const model = body.model;
            this.capturedEmbeddings.push({
                receivedAt: Date.now(),
                model,
                inputType:
                    typeof body.input_type === "string"
                        ? body.input_type
                        : null,
                inputs,
            });
            return new Response(
                JSON.stringify({
                    object: "list",
                    model,
                    data: inputs.map((text, index) => ({
                        object: "embedding",
                        index,
                        embedding: deterministicEmbedding(text),
                    })),
                    usage: { prompt_tokens: 0, total_tokens: 0 },
                }),
                {
                    status: 200,
                    headers: { "content-type": "application/json" },
                },
            );
        }

        // `baseURL` may include `/v1`, so the mock accepts both paths.
        const isMessages =
            url.pathname === "/messages" || url.pathname === "/v1/messages";

        if (method === "POST" && isMessages) {
            let body: Record<string, unknown> = {};
            try {
                body = (await req.json()) as Record<string, unknown>;
            } catch {
                body = {};
            }

            const headers: Record<string, string> = {};
            req.headers.forEach((value, key) => {
                headers[key] = value;
            });

            const captured: CapturedRequest = {
                receivedAt: Date.now(),
                method,
                path: url.pathname,
                headers,
                body,
            };
            this.captured.push(captured);

            // First non-null matcher result determines the response.
            let matcherResponse: MockResponse | null = null;
            for (const matcher of this.matchers) {
                const resp = matcher(body, headers);
                if (resp !== null) {
                    matcherResponse = resp;
                    break;
                }
            }
            const fromQueue = matcherResponse === null ? this.responses.shift() : undefined;
            const scripted = matcherResponse ?? fromQueue ?? this.defaultResponse;
            if (matcherResponse === null && fromQueue === undefined && this.defaultResponse !== null) {
                this.defaultHitCount += 1;
            }
            if (!scripted) {
                return new Response(
                    JSON.stringify({
                        type: "error",
                        error: {
                            type: "mock_error",
                            message: "No scripted response available",
                        },
                    }),
                    {
                        status: 500,
                        headers: { "content-type": "application/json" },
                    },
                );
            }

            if (scripted.delayMs && scripted.delayMs > 0) {
                await Bun.sleep(scripted.delayMs);
            }
            captured.responseCompletedAt = Date.now();

            // When `scripted.error` is set, emit an Anthropic-shaped JSON error body with the requested HTTP status.
            // The error response bypasses the SSE streaming path.
            if (scripted.error) {
                return new Response(
                    JSON.stringify({
                        type: "error",
                        error: {
                            type: scripted.error.type,
                            message: scripted.error.message,
                        },
                    }),
                    {
                        status: scripted.error.status,
                        headers: { "content-type": "application/json" },
                    },
                );
            }

            const usage = scripted.usage;
            if (!usage) {
                return new Response(
                    JSON.stringify({
                        type: "error",
                        error: {
                            type: "mock_error",
                            message: "MockResponse requires `usage` or `error`",
                        },
                    }),
                    {
                        status: 500,
                        headers: { "content-type": "application/json" },
                    },
                );
            }

            const content = scripted.content ?? [
                { type: "text", text: scripted.text ?? "OK" },
            ];

            const respModel =
                scripted.model ??
                (typeof body.model === "string" ? body.model : "mock-model");

            const wantsStream = body.stream === true;
            const messageId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

            if (wantsStream) {
                // The stream emits `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, and `message_stop` in that order.
                // The stream emits `content_block_stop`, then `message_delta` with final usage, then `message_stop`.
                const encoder = new TextEncoder();
                const stream = new ReadableStream({
                    start(controller) {
                        const send = (
                            event: string,
                            data: Record<string, unknown>,
                        ) => {
                            controller.enqueue(
                                encoder.encode(
                                    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
                                ),
                            );
                        };

                        send("message_start", {
                            type: "message_start",
                            message: {
                                id: messageId,
                                type: "message",
                                role: "assistant",
                                model: respModel,
                                content: [],
                                stop_reason: null,
                                stop_sequence: null,
                                usage: {
                                    input_tokens: usage.input_tokens,
                                    output_tokens: 0,
                                    cache_creation_input_tokens:
                                        usage.cache_creation_input_tokens ?? 0,
                                    cache_read_input_tokens:
                                        usage.cache_read_input_tokens ?? 0,
                                },
                            },
                        });

                        content.forEach((block: unknown, index: number) => {
                            const blk = block as {
                                type?: string;
                                text?: string;
                                thinking?: string;
                                signature?: string;
                                data?: string;
                            };
                            const blockType = blk.type ?? "text";

                            if (blockType === "text") {
                                send("content_block_start", {
                                    type: "content_block_start",
                                    index,
                                    content_block: { type: "text", text: "" },
                                });
                                send("content_block_delta", {
                                    type: "content_block_delta",
                                    index,
                                    delta: {
                                        type: "text_delta",
                                        text: blk.text ?? "",
                                    },
                                });
                                send("content_block_stop", {
                                    type: "content_block_stop",
                                    index,
                                });
                            } else if (blockType === "thinking") {
                                // A thinking block emits a start event, a thinking delta, and a signature delta.
                                // 4. content_block_stop
                                send("content_block_start", {
                                    type: "content_block_start",
                                    index,
                                    content_block: {
                                        type: "thinking",
                                        thinking: "",
                                    },
                                });
                                if (blk.thinking) {
                                    send("content_block_delta", {
                                        type: "content_block_delta",
                                        index,
                                        delta: {
                                            type: "thinking_delta",
                                            thinking: blk.thinking,
                                        },
                                    });
                                }
                                if (blk.signature) {
                                    send("content_block_delta", {
                                        type: "content_block_delta",
                                        index,
                                        delta: {
                                            type: "signature_delta",
                                            signature: blk.signature,
                                        },
                                    });
                                }
                                send("content_block_stop", {
                                    type: "content_block_stop",
                                    index,
                                });
                            } else if (blockType === "redacted_thinking") {
                                // The redacted-thinking block emits no deltas; its start event carries opaque `data`.
                                send("content_block_start", {
                                    type: "content_block_start",
                                    index,
                                    content_block: {
                                        type: "redacted_thinking",
                                        data: blk.data ?? "",
                                    },
                                });
                                send("content_block_stop", {
                                    type: "content_block_stop",
                                    index,
                                });
                            } else if (blockType === "tool_use") {
                                const toolBlock = block as {
                                    type: "tool_use";
                                    id?: string;
                                    name?: string;
                                    input?: Record<string, unknown>;
                                };
                                send("content_block_start", {
                                    type: "content_block_start",
                                    index,
                                    content_block: {
                                        type: "tool_use",
                                        id: toolBlock.id ?? `toolu_${index}`,
                                        name: toolBlock.name ?? "mock_tool",
                                        input: {},
                                    },
                                });
                                send("content_block_delta", {
                                    type: "content_block_delta",
                                    index,
                                    delta: {
                                        type: "input_json_delta",
                                        partial_json: JSON.stringify(
                                            toolBlock.input ?? {},
                                        ),
                                    },
                                });
                                send("content_block_stop", {
                                    type: "content_block_stop",
                                    index,
                                });
                            } else {
                                // Non-text blocks pass through unchanged.
                                send("content_block_start", {
                                    type: "content_block_start",
                                    index,
                                    content_block: block,
                                });
                                send("content_block_stop", {
                                    type: "content_block_stop",
                                    index,
                                });
                            }
                        });

                        send("message_delta", {
                            type: "message_delta",
                            delta: {
                                stop_reason: scripted.stop_reason ?? "end_turn",
                                stop_sequence: null,
                            },
                            usage: {
                                // `message_delta.usage` repeats the cumulative usage sent in `message_start`.
                                input_tokens: usage.input_tokens,
                                cache_creation_input_tokens:
                                    usage.cache_creation_input_tokens ?? 0,
                                cache_read_input_tokens:
                                    usage.cache_read_input_tokens ?? 0,
                                output_tokens: usage.output_tokens,
                            },
                        });

                        send("message_stop", { type: "message_stop" });
                        controller.close();
                    },
                });

                return new Response(stream, {
                    status: 200,
                    headers: {
                        "content-type": "text/event-stream",
                        "cache-control": "no-cache",
                        connection: "keep-alive",
                    },
                });
            }

            const responseBody = {
                id: messageId,
                type: "message",
                role: "assistant",
                model: respModel,
                content,
                stop_reason: scripted.stop_reason ?? "end_turn",
                stop_sequence: null,
                usage: {
                    input_tokens: usage.input_tokens,
                    output_tokens: usage.output_tokens,
                    cache_creation_input_tokens:
                        usage.cache_creation_input_tokens ?? 0,
                    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
                },
            };

            return new Response(JSON.stringify(responseBody), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }

        return new Response(
            JSON.stringify({ error: "not_found", path: url.pathname }),
            {
                status: 404,
                headers: { "content-type": "application/json" },
            },
        );
    }
}
