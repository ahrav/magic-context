#!/usr/bin/env python3
"""Check every `@cortexkit/subc-client` item this repo uses against the EXACT
published package (0.4.1), whose declarations ship in the npm tarball.

Run from the extracted tarball root (the directory containing `package/`):

    curl -sSL -o subc-client-0.4.1.tgz \
        https://registry.npmjs.org/@cortexkit/subc-client/-/subc-client-0.4.1.tgz
    tar xzf subc-client-0.4.1.tgz
    cd package && python3 ../verify-ts-surface.py

Prints PRESENT/ABSENT per inventory row against package/dist/*.d.ts.
"""

from __future__ import annotations

import os
import sys

ITEMS: tuple[tuple[str, str], ...] = (
    ("SubcClient", "export declare class SubcClient"),
    ("SubcClient.connect", "static connect(opts: ConnectOptions)"),
    ("SubcClient.routeOpen", "routeOpen(target: RouteTarget, identity: BindIdentity"),
    (
        "SubcClient.request",
        "request(handle: RouteHandle, body: unknown, opts?: RequestOptions)",
    ),
    ("SubcClient.call", "call<Response = unknown>(moduleId: string, method: string"),
    ("SubcClient.catalogList", "catalogList(moduleId?: string)"),
    (
        "SubcClient.closeRoute",
        "closeRoute(handle: RouteHandle, opts?: CloseRouteOptions)",
    ),
    ("SubcClient.close", "close(): void"),
    ("BindIdentity", "export interface BindIdentity"),
    ("RouteTarget", "export type RouteTarget"),
    ("RouteHandle", "declare class RouteHandle"),
    ("RequestOptions", "export interface RequestOptions"),
    ("ManagedCallOptions", "export interface ManagedCallOptions"),
    ("ManagedCallOptions.targetKind", "targetKind?: ManagedRouteKind"),
    ("ManagedCallOptions.identity", "identity?: BindIdentity"),
    ("ConnectOptions.handshakeTimeoutMs", "handshakeTimeoutMs?: number"),
    ("CatalogEntry.control_ops", "control_ops: string[]"),
    ("Priority", "Priority"),
    ("AdmissionClass", "AdmissionClass"),
    ("SubcCallError", "export declare class SubcCallError"),
    ("SubcCallError.kind", "readonly kind: SubcCallErrorKind"),
    (
        "SubcCallErrorKind values",
        'export type SubcCallErrorKind = "not_sent" | "outcome_unknown" | "terminal"',
    ),
    ("StaleRouteHandleError", "StaleRouteHandleError"),
    ("SocketClosedError", "SocketClosedError"),
    ("SocketTimeoutError", "SocketTimeoutError"),
    (
        "isConsumerReconnectTransient",
        "export declare function isConsumerReconnectTransient",
    ),
    ("connectionFileExists", "export declare function connectionFileExists"),
    ("HEADER_LEN", "HEADER_LEN"),
    ("PROTOCOL_VERSION", "PROTOCOL_VERSION"),
    ("SERVER_PROOF_DOMAIN", "SERVER_PROOF_DOMAIN"),
    ("SubcProvider", "export declare class SubcProvider"),
    ("managementSurfaceManifest", "export declare function managementSurfaceManifest"),
    ("ProviderRequestContext", "ProviderRequestContext"),
    ("RouteBindRequest", "RouteBindRequest"),
)


def read_declarations(dist_dir: str) -> str:
    """Concatenate every .d.ts file in dist_dir."""
    parts: list[str] = []
    try:
        names = sorted(os.listdir(dist_dir))
    except OSError as error:
        print(f"error: could not list {dist_dir}: {error}", file=sys.stderr)
        return ""
    for name in names:
        if not name.endswith(".d.ts"):
            continue
        path = os.path.join(dist_dir, name)
        try:
            with open(path, encoding="utf-8") as handle:
                parts.append(handle.read())
        except OSError as error:
            print(f"warning: could not read {path}: {error}", file=sys.stderr)
    return "".join(parts)


def main() -> int:
    declarations = read_declarations("dist")
    if not declarations:
        print(
            "error: no dist/*.d.ts found; run this from the extracted `package/` "
            "directory (see this file's docstring)",
            file=sys.stderr,
        )
        return 2

    absent: list[str] = []
    for name, probe in ITEMS:
        present = probe in declarations
        if not present:
            absent.append(name)
        status = "PRESENT" if present else "ABSENT "
        print(f"{status:8} @cortexkit/subc-client@0.4.1  {name}")

    print("\nABSENT:", ", ".join(absent) if absent else "none")
    return 0


if __name__ == "__main__":
    sys.exit(main())
