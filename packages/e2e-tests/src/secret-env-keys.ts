/**
 * Whether an environment variable name denotes a credential or other sensitive
 * value.
 *
 * Matched on the name, never the value. A test may legitimately carry a fake
 * credential whose shape is indistinguishable from a real one, so a value-based
 * check would have to guess per vendor and would drag the secret itself into
 * whatever reports the decision. Names are the repository's own convention, so
 * they are the part we can hold.
 *
 * Three halves, because none catches the others' cases. The suffix half misses
 * vendor names that carry no secret-shaped word — `OPENAI_KEY`, `GCP_SA_KEY`, and
 * `SSH_KEY` all name credentials while matching none of `API_KEY`, `ACCESS_KEY`,
 * or `PRIVATE_KEY`. The vendor half misses everything from a vendor not on the
 * list, such as a bare `GITHUB_TOKEN` or `NPM_TOKEN`. Neither catches a
 * connection string, whose credentials live in the value's userinfo rather than
 * anywhere in the name: `DATABASE_URL` reads as innocuous and routinely carries
 * `scheme://user:password@host`.
 *
 * This is a denylist over names, so it is leaky by construction: it can only
 * refuse shapes someone thought of. It is the right trade for the two guards
 * whose failure mode is a loud refusal, and it is a floor rather than a ceiling
 * for the inheritance filter. Prefer adding a shape here over widening what a
 * child inherits.
 *
 * Over-matching is the safe direction for every caller: one refuses the key
 * outright, one declines to forward it to a child process, and one demands a
 * loopback bind. A false positive costs a caller an explicit opt-in or one
 * dropped variable; a false negative costs a credential.
 */
const SECRET_ENV_KEY_PATTERN =
    /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|ACCESS_KEY|PRIVATE_KEY|COOKIE|AUTH)/i;

const SENSITIVE_VENDOR_PREFIX_PATTERN =
    /^(?:AWS|AZURE|GOOGLE|GCP|OPENAI|ANTHROPIC|COHERE|HUGGINGFACE|SSH)_/i;

/**
 * Connection-string names that conventionally embed credentials in the value.
 * Matched by name like the rest, rather than by parsing userinfo out of the
 * value, so one mechanism governs all three classes and no secret is read to
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
