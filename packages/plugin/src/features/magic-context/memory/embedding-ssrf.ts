/**
 *
 * Cloud metadata services are common SSRF targets.
 *
 * The guard blocks known metadata endpoints without blocking all internal networks.
 * Self-hosted embedding servers can run on localhost or RFC1918 addresses.
 *     working.
 *
 * The guard compares host strings and does not resolve DNS.
 * An attacker can point a domain at a link-local IP through DNS rebinding.
 * The guard blocks literal metadata endpoints but does not prevent DNS-based bypasses.
 */

const METADATA_HOSTNAMES = new Set(["metadata.google.internal", "metadata.goog"]);

/**
 * AWS exposes instance metadata at `fd00:ec2::254` in addition to `169.254.169.254`.
 * The guard does not block `fc00::/7` because ULA addresses can host self-hosted embedding servers.
 * WHATWG URL canonicalizes IPv6 addresses before hostname comparison.
 * WHATWG URL compresses equivalent IPv6 literals, so `IPV6_METADATA_HOSTS` uses `fd00:ec2::254`.
 */
const IPV6_METADATA_HOSTS = new Set(["fd00:ec2::254"]);

/** The link-local range `169.254.0.0/16` includes the cloud metadata IP. */
function isLinkLocalIpv4(host: string): boolean {
    return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * WHATWG URL canonicalizes plain IPv4 literals to dotted decimal for HTTP(S) URLs.
 * WHATWG URL preserves IPv4-mapped IPv6 addresses in hexadecimal form.
 * WHATWG URL canonicalizes the address in `[::ffff:169.254.169.254]` to `::ffff:a9fe:a9fe`.
 * Without decoding `::ffff:a9fe:a9fe`, a host-string check misses the mapped metadata IP.
 */
function ipv4FromMappedIpv6(host: string): string | null {
    const m = /^::ffff:(.+)$/.exec(host);
    if (!m) return null;
    const tail = m[1];
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return tail;
    // Each 16-bit group contributes two IPv4 octets.
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hex) {
        const hi = Number.parseInt(hex[1], 16);
        const lo = Number.parseInt(hex[2], 16);
        if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
        return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
    return null;
}

/**
 * The function returns a non-empty reason for blocked endpoints and `null` otherwise.
 * Malformed URLs return a block reason.
 */
export function blockedEmbeddingEndpointReason(endpoint: string): string | null {
    const trimmed = endpoint.trim();
    if (trimmed.length === 0) return null; // empty → provider already no-ops

    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return `embedding endpoint is not a valid URL: ${trimmed}`;
    }

    // WHATWG URL keeps brackets on IPv6 hostnames; `host` strips them before comparison.
    // Lowercasing makes hexadecimal IPv6 host comparisons case-insensitive.
    const host = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");

    if (METADATA_HOSTNAMES.has(host)) {
        return `embedding endpoint host ${host} is a cloud metadata service (blocked)`;
    }
    if (IPV6_METADATA_HOSTS.has(host)) {
        return `embedding endpoint host ${host} is the AWS IPv6 metadata service (blocked)`;
    }
    if (isLinkLocalIpv4(host)) {
        return `embedding endpoint host ${host} is link-local / cloud metadata (blocked)`;
    }
    // IPv4-mapped IPv6 literals can encode link-local metadata addresses.
    const mappedV4 = ipv4FromMappedIpv6(host);
    if (mappedV4 && isLinkLocalIpv4(mappedV4)) {
        return `embedding endpoint host ${host} (IPv4-mapped ${mappedV4}) is link-local / cloud metadata (blocked)`;
    }
    // TODO: Block the full IPv6 link-local range `fe80::/10`.
    if (host.startsWith("fe80:")) {
        return `embedding endpoint host ${host} is link-local / cloud metadata (blocked)`;
    }

    return null;
}
