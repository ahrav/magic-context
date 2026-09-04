import { z } from "zod";
export declare const AgentOverrideConfigSchema: z.ZodObject<{
    model: z.ZodOptional<z.ZodString>;
    temperature: z.ZodOptional<z.ZodNumber>;
    top_p: z.ZodOptional<z.ZodNumber>;
    prompt: z.ZodOptional<z.ZodString>;
    tools: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
    disable: z.ZodOptional<z.ZodBoolean>;
    description: z.ZodOptional<z.ZodString>;
    mode: z.ZodOptional<z.ZodEnum<{
        primary: "primary";
        subagent: "subagent";
        all: "all";
    }>>;
    color: z.ZodOptional<z.ZodString>;
    maxSteps: z.ZodOptional<z.ZodNumber>;
    permission: z.ZodOptional<z.ZodObject<{
        edit: z.ZodOptional<z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>>;
        bash: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>, z.ZodRecord<z.ZodString, z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>>]>>;
        webfetch: z.ZodOptional<z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>>;
        doom_loop: z.ZodOptional<z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>>;
        external_directory: z.ZodOptional<z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>>;
    }, z.core.$strip>>;
    maxTokens: z.ZodOptional<z.ZodNumber>;
    variant: z.ZodOptional<z.ZodString>;
    fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
}, z.core.$strip>;
//# sourceMappingURL=agent-overrides.d.ts.map