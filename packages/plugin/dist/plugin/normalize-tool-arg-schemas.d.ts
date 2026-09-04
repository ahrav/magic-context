import { type ToolDefinition } from "@opencode-ai/plugin";
/**
 * Patches each arg schema with a toJSONSchema override so that
 * property-level descriptions from .describe() survive JSON Schema serialization.
 */
export declare function normalizeToolArgSchemas<TDefinition extends Pick<ToolDefinition, "args">>(toolDefinition: TDefinition): TDefinition;
//# sourceMappingURL=normalize-tool-arg-schemas.d.ts.map