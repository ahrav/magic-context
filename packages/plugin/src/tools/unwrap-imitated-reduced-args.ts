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
          /**
           * Fields in `optionalFields` may be absent or null; present non-null values must validate against their rules.
           */
          optionalFields?: Readonly<Record<string, ImitatedArgRule>>;
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
 * Nested objects must contain every required field and no undeclared fields.
 * An undeclared field would reach the tool unvalidated.
 */
function validObjectField(
    value: unknown,
    fields: Readonly<Record<string, ImitatedArgRule>>,
    optionalFields: Readonly<Record<string, ImitatedArgRule>> = {},
): boolean {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const required = Object.entries(fields);
    if (
        !required.every(
            ([field, rule]) => Object.hasOwn(record, field) && validField(record[field], rule),
        )
    ) {
        return false;
    }
    return Object.keys(record).every((field) => {
        if (Object.hasOwn(fields, field)) return true;
        const rule = optionalFields[field];
        if (rule === undefined) return false;
        return record[field] === null || validField(record[field], rule);
    });
}

function validField(value: unknown, rule: ImitatedArgRule): boolean {
    if (rule === "string") {
        return typeof value === "string" && value.length <= MAX_DECODED_STRING_LENGTH;
    }
    if (rule === "number") return typeof value === "number" && Number.isFinite(value);
    if (rule === "boolean") return typeof value === "boolean";
    if (rule.type === "enum") return typeof value === "string" && rule.values.includes(value);
    if (rule.type === "object") return validObjectField(value, rule.fields, rule.optionalFields);
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
 * Models can imitate the clamped argument shape from reduced tool-call history.
 * The tool boundary decodes that shape once, then validates it against the fields and types the tool exposes.
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
    } catch {}

    return args;
}
