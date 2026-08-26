/**
 * Whether an environment variable name denotes a secret value.
 *
 * Matched on the name, never the value. A test may legitimately carry a fake
 * credential whose shape is indistinguishable from a real one, so a value-based
 * check would have to guess per vendor and would drag the secret itself into
 * whatever reports the decision. Names are the repository's own convention, so
 * they are the part we can hold.
 *
 * Over-matching is the safe direction for both callers: one refuses the key
 * outright, the other demands a loopback bind, and a false positive costs a
 * caller an explicit opt-in rather than an exposed credential.
 */
const SECRET_ENV_KEY_PATTERN =
    /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|ACCESS_KEY|PRIVATE_KEY|COOKIE|AUTH)/i;

export function isSecretEnvKey(key: string): boolean {
    return SECRET_ENV_KEY_PATTERN.test(key);
}
