/**
 * The compiled TUI may resolve only these specifiers through OpenCode's process-wide OpenTUI registry.
 * OpenCode exposes each specifier as `opentui:runtime-module:<encoded>` in its process-wide OpenTUI registry.
 *
 * `scripts/build-tui.ts` rewrites these specifiers, and `tui-compiled-runtime-imports.test.ts` validates every emitted specifier against a real export.
 * `TUI_RUNTIME_SPECIFIERS` prevents the guard test from missing specifiers that `build-tui.ts` rewrites.
 *
 * `TUI_RUNTIME_SPECIFIERS` must remain in `src/shared/` because `build-tui.ts` copies `src/tui/` into `src/tui-compiled/`, which must exclude build and test tooling.
 */
export const TUI_RUNTIME_SPECIFIERS = [
    "@opentui/core",
    "@opentui/core/testing",
    "@opentui/solid",
    "@opentui/solid/components",
    "@opentui/solid/jsx-runtime",
    "@opentui/solid/jsx-dev-runtime",
    "solid-js",
    "solid-js/store",
] as const;

export type TuiRuntimeSpecifier = (typeof TUI_RUNTIME_SPECIFIERS)[number];

/** OpenCode registers this virtual module ID for each runtime specifier. */
export function runtimeModuleId(specifier: string): string {
    return `opentui:runtime-module:${encodeURIComponent(specifier)}`;
}
