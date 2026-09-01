/**
 * value.
 *
 * Match environment-variable names, not values.
 *
 * Vendor prefixes catch `OPENAI_KEY`, `GCP_SA_KEY`, and `SSH_KEY`, which lack suffix-pattern terms.
 * `scheme://user:password@host`.
 *
 * Finite name patterns cannot detect unlisted secret names.
 * child inherits.
 *
 */
const SECRET_ENV_KEY_PATTERN =
    /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|ACCESS_KEY|PRIVATE_KEY|COOKIE|AUTH)/i;

const SENSITIVE_VENDOR_PREFIX_PATTERN =
    /^(?:AWS|AZURE|GOOGLE|GCP|OPENAI|ANTHROPIC|COHERE|HUGGINGFACE|SSH)_/i;

/**
 * decide.
 */
const CREDENTIAL_BEARING_URI_PATTERN =
    /(?:DATABASE_URL|DATABASE_URI|POSTGRES_URL|POSTGRESQL_URL|MYSQL_URL|MONGODB_URI|MONGO_URL|REDIS_URL|AMQP_URL|CONNECTION_STRING|_DSN)/i;

export function isSensitiveEnvKey(key: string): boolean {
    return (
        SECRET_ENV_KEY_PATTERN.test(key) ||
        SENSITIVE_VENDOR_PREFIX_PATTERN.test(key) ||
        CREDENTIAL_BEARING_URI_PATTERN.test(key)
    );
}
