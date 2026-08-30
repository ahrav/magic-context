/**
 * Shared e2e harness fixture primitives.
 *
 * The opencode, rust, and pi harnesses configure the same mock provider and
 * speak to the same SDK session surface. The default mock response, the
 * common SDK client shape, and the option fields every harness accepts live
 * here so the three harness facades cannot drift apart on the shared
 * contract; each harness extends these with its own additions.
 */

import type { MockResponse } from "./mock-provider/server";

/**
 * Default response used when the mock queue is empty. Lets tests send extra
 * prompts without worrying about scripting every one.
 */
export const DEFAULT_MOCK_RESPONSE: MockResponse = {
    text: "ok",
    usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 0,
    },
};

/** Option fields shared by every harness facade. */
export interface SharedHarnessOptions {
    /** magic-context config overrides. Merged onto test defaults. */
    magicContextConfig?: Record<string, unknown>;
    /** Extra opencode.json config. Merged onto test defaults. */
    openCodeConfigExtra?: Record<string, unknown>;
    /** Override the mock model's context token limit. Default 200000. */
    modelContextLimit?: number;
    /** Default response used when the mock queue is empty. */
    mockDefault?: MockResponse;
}

/**
 * SDK session surface every harness client exposes. Harness-specific clients
 * intersect the `session` object with their own extra endpoints.
 */
export interface SdkClientCore {
    session: {
        create: (opts: {
            query: { directory: string };
            body?: { parentID?: string; title?: string };
        }) => Promise<{ data?: { id: string } }>;
        prompt: (opts: {
            path: { id: string };
            body: {
                model: { providerID: string; modelID: string };
                parts: Array<{ type: "text"; text: string }>;
                agent?: string;
            };
        }) => Promise<{ data?: unknown }>;
        messages: (opts: { path: { id: string } }) => Promise<{ data?: unknown }>;
    };
}
