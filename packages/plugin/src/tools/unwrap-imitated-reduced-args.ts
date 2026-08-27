export interface ImitatedReducedArgs {
    reduced?: boolean;
    summary?: string;
}

export type ImitatedArgRule =
    | "string"
    | "number"
    | "boolean"
    | {
          type: "enum";
          values: readonly string[];
      }
    | {
          type: "object";
          fields: Readonly<Record<string, ImitatedArgRule>>;
          optionalFields?: Readonly<Record<string, ImitatedArgRule>>;
      }
    | {
          type: "nullable";
          value: ImitatedArgRule;
      }
    | {
          type: "array";
          items: ImitatedArgRule;
          maxItems?: number;
          values?: readonly string[];
      };

export type ImitatedArgsSchema = Readonly<Record<string, ImitatedArgRule>>;

const MAX_DECODED_STRING_LENGTH = 1024 * 1024;
const MAX_DECODED_ARRAY_ITEMS = 100;

/**
 * Nested objects must match their declared field set exactly. An undeclared field
 * would reach the tool unvalidated, and a missing field would let a partial value
 * (a mutation token short one digest) through to the mutation path.
 */
function validObjectField(
    value: unknown,
    fields: Readonly<Record<string, ImitatedArgRule>>,
    optionalFields: Readonly<Record<string, ImitatedArgRule>> = {},
): boolean {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const declared = Object.entries(fields);
    if (Object.keys(record).some((field) => !(field in fields) && !(field in optionalFields))) {
        return false;
    }
    return (
        declared.every(
            ([field, rule]) => Object.hasOwn(record, field) && validField(record[field], rule),
        ) &&
        Object.entries(optionalFields).every(
            ([field, rule]) => !Object.hasOwn(record, field) || validField(record[field], rule),
        )
    );
}

function validField(value: unknown, rule: ImitatedArgRule): boolean {
    if (rule === "string") {
        return typeof value === "string" && value.length <= MAX_DECODED_STRING_LENGTH;
    }
    if (rule === "number") return typeof value === "number" && Number.isFinite(value);
    if (rule === "boolean") return typeof value === "boolean";
    if (rule.type === "enum") return typeof value === "string" && rule.values.includes(value);
    if (rule.type === "object") return validObjectField(value, rule.fields, rule.optionalFields);
    if (rule.type === "nullable") return value === null || validField(value, rule.value);
    if (!Array.isArray(value) || value.length > (rule.maxItems ?? MAX_DECODED_ARRAY_ITEMS)) {
        return false;
    }
    return value.every((item) => {
        if (rule.items === "number") return typeof item === "number" && Number.isFinite(item);
        if (rule.items === "string") {
            return (
                typeof item === "string" &&
                item.length <= MAX_DECODED_STRING_LENGTH &&
                (rule.values === undefined || rule.values.includes(item))
            );
        }
        return validField(item, rule.items);
    });
}

function validDecodedArgs(value: Record<string, unknown>, schema: ImitatedArgsSchema): boolean {
    for (const [field, fieldValue] of Object.entries(value)) {
        if (field === "reduced") {
            if (typeof fieldValue !== "boolean") return false;
            continue;
        }
        if (field === "summary") {
            if (typeof fieldValue !== "string" || fieldValue.length > MAX_DECODED_STRING_LENGTH) {
                return false;
            }
            continue;
        }
        const rule = schema[field];
        if (!rule || !validField(fieldValue, rule)) return false;
    }
    return true;
}

/**
 * Models can imitate the clamped argument shape they see in reduced tool-call
 * history. Decode that shape once at the tool boundary, then validate the decoded
 * object against the same fields and types the tool exposes before returning it.
 */
export function unwrapImitatedReducedArgs<T extends object>(
    args: T,
    primaryFields: readonly string[],
    schema: ImitatedArgsSchema,
): T {
    const record = args as Record<string, unknown>;
    if (
        primaryFields.some((field) => record[field] !== undefined) ||
        record.reduced !== true ||
        typeof record.summary !== "string"
    ) {
        return args;
    }

    try {
        const parsed: unknown = JSON.parse(record.summary);
        if (
            parsed !== null &&
            typeof parsed === "object" &&
            !Array.isArray(parsed) &&
            validDecodedArgs(parsed as Record<string, unknown>, schema)
        ) {
            return parsed as T;
        }
    } catch {
        // Keep the validated outer arguments so the tool reports its ordinary field error.
    }

    return args;
}
