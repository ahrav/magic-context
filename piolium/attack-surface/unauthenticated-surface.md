# Unauthenticated Attack Surface

Reachable by an anonymous attacker — no valid session, token, or API key.

**Coverage**: 5 entry points | 5 by-design public | 0 missing-guard / middleware-gap  
**Auth model**: Dashboard API identity is a random 256-bit bearer enforced by Axum `api_guard` (`packages/dashboard/src-tauri/src/serve/mod.rs:243-261`); OpenCode TUI RPC/WS uses a random per-process bearer from an owner-private discovery file (`packages/plugin/src/shared/rpc-server.ts:50-67,157-205,259-287`). Tauri IPC trusts bundled local frontend/capability origin rather than a user session. Static docs have no auth.  
**Coverage gaps**: generated Astro/Starlight routes and deployment-layer redirects/headers were not built or enumerated; embedded dashboard asset names are build-generated; external OpenCode/Pi/subc listeners are outside this repository.

## Pre-Auth HTTP / API Routes

| # | Method | Path | Handler (file:line) | Why pre-auth | Notable inputs / sinks | Blast radius |
|---|---|---|---|---|---|---|
| 1 | GET | `/` | `index_handler` (`packages/dashboard/src-tauri/src/serve/mod.rs:160,279-284`) | by-design | Returns embedded `index.html`; CSP/security headers; no DB access; index is `no-store` | Public dashboard shell only; sensitive API still requires bearer |
| 2 | GET | `/assets/*path` | `asset_handler` (`packages/dashboard/src-tauri/src/serve/mod.rs:161,286-314`) | by-design | Embedded assets only; rejects empty, `..`, backslash, and absolute path spellings | Public client JS/CSS/images; no arbitrary host filesystem access |
| 3 | GET | any non-`/api` SPA path | `spa_fallback` (`packages/dashboard/src-tauri/src/serve/mod.rs:162,316-326`) | by-design | GET returns embedded index; non-GET returns 404 | Public UI shell only |
| 4 | GET | `/health` | `MagicContextRpcServer.handleFetch` (`packages/plugin/src/shared/rpc-server.ts:270-272`) | by-design | Returns `{ok,pid,instance_id}`; no CORS and no mutation | Low-sensitivity local process metadata; loopback only |
| 5 | GET/HEAD | `/magic-context/**` on `docs.cortexkit.io` | Cloudflare static assets from Astro output (`packages/docs/astro.config.mjs`; `packages/docs/wrangler.jsonc:5-15`) | by-design | Public documentation HTML/assets; no repository-defined dynamic handlers | Static public content only |

## Other Unauthenticated Entry Points

| Kind | Entry point (file:line) | Why pre-auth | Notes |
|---|---|---|---|
| Static file server | Dashboard embedded asset/SPA router (`packages/dashboard/src-tauri/src/serve/mod.rs:158-162`) | by-design | Included in route rows 1-3; listed here because it is the non-API surface of the same listener |
| Static documentation | Cloudflare assets deployment (`packages/docs/wrangler.jsonc:5-15`) | by-design | No Worker script or application session in repository config |

### Protected surfaces excluded from the table

- `POST /api/invoke` and all unknown `/api/*` paths run Host, Origin, bearer, and JSON checks before handler dispatch (`serve/mod.rs:148-156,243-261`).
- OpenCode `/rpc/*` and `/ws` require the per-process bearer; only `/health` is public (`rpc-server.ts:259-287`).
- Tauri commands are not internet routes. They are reachable by the bundled webview under Tauri's local-origin/capability model; current Rust Tauri is 2.11.3, above the 2.11.1 origin-confusion fix.
- CLI, stdin provider, SQLite files, and subc module require local process/file/transport access and are not anonymous network entry points under the baseline deployment.
