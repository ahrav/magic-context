export interface ImitatedReducedArgs {
    reduced?: boolean;
    summary?: string;
}
export type ImitatedArgRule = "string" | "number" | "boolean" | {
    type: "enum";
    values: readonly string[];
} | {
    type: "object";
    fields: Readonly<Record<string, ImitatedArgRule>>;
    /**
     * Fields that may be absent or null. When present and non-null the
     * value must validate against its rule. Without this, a decode schema
     * that omits an advertised optional field rejects the whole imitated
     * call and loses the action.
     */
    optionalFields?: Readonly<Record<string, ImitatedArgRule>>;
} | {
    type: "array";
    items: ImitatedArgRule;
    maxItems?: number;
    values?: readonly string[];
};
export type ImitatedArgsSchema = Readonly<Record<string, ImitatedArgRule>>;
/**
 * Models can imitate the clamped argument shape they see in reduced tool-call
 * history. Decode that shape once at the tool boundary, then validate the decoded
 * object against the same fields and types the tool exposes before returning it.
 */
export declare function unwrapImitatedReducedArgs<T extends object>(args: T, primaryFields: readonly string[], schema: ImitatedArgsSchema): T;
//# sourceMappingURL=unwrap-imitated-reduced-args.d.ts.map