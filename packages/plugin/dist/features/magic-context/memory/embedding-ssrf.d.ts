/**
 * Narrow SSRF guard for the OpenAI-compatible embedding endpoint.
 *
 * The endpoint can be set from a (now-hardened, but still attacker-influenced)
 * project config. The request body is memory content, which can contain
 * captured secrets/code. The classic SSRF target is the cloud **metadata**
 * service (`169.254.169.254` / `metadata.google.internal`), reachable from
 * inside most cloud VMs with no auth.
 *
 * Design choice — proportionate, NOT a blanket internal-network block:
 *   - BLOCK link-local (169.254.0.0/16, incl. AWS/GCP/Azure metadata) and the
 *     known metadata hostnames. These are never a legitimate embedding host.
 *   - ALLOW loopback (127.0.0.0/8, localhost, ::1) and RFC1918 private ranges
 *     (10/8, 172.16/12, 192.168/16). Self-hosted embeddings (LMStudio on
 *     localhost, Ollama on a LAN GPU box) are the common case and must keep
 *     working.
 *
 * This is a string/host-level check, not a DNS-resolving guard: a determined
 * attacker could still point a domain at a link-local IP (DNS rebinding). Full
 * resolution-time protection is heavier and deferred; this closes the direct
 * literal-metadata-endpoint vector without breaking any legitimate setup.
 */
/**
 * Returns a non-empty reason string when the endpoint host is blocked, or null
 * when it is allowed. Malformed URLs are blocked (fail closed) since a config
 * value that can't even be parsed as a URL should not reach `fetch`.
 */
export declare function blockedEmbeddingEndpointReason(endpoint: string): string | null;
//# sourceMappingURL=embedding-ssrf.d.ts.map