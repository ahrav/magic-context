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
 * Two halves, because neither catches the other's cases. The suffix half misses
 * vendor names that carry no secret-shaped word — `OPENAI_KEY`, `GCP_SA_KEY`, and
 * `SSH_KEY` all name credentials while matching none of `API_KEY`, `ACCESS_KEY`,
 * or `PRIVATE_KEY`. The vendor half misses everything from a vendor not on the
 * list, such as a bare `GITHUB_TOKEN` or `NPM_TOKEN`.
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

export function isSensitiveEnvKey(key: string): boolean {
    return SECRET_ENV_KEY_PATTERN.test(key) || SENSITIVE_VENDOR_PREFIX_PATTERN.test(key);
}
