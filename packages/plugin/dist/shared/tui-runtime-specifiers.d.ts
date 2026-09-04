/**
 * The module specifiers the compiled TUI is allowed to resolve through OpenCode's
 * process-wide OpenTUI runtime registry (`opentui:runtime-module:<encoded>`).
 *
 * Single source of truth, shared by `scripts/build-tui.ts` (which rewrites these
 * specifiers during the Solid transform) and
 * `src/tui/tui-compiled-runtime-imports.test.ts` (which verifies every emitted
 * specifier names a real export). Keeping one list means the guard test cannot
 * drift into skipping a specifier the build actually rewrites — a skipped
 * specifier is exactly the silent hole the test exists to close.
 *
 * Lives in `src/shared/` rather than `src/tui/` on purpose: `build-tui.ts` copies
 * every file under `src/tui/` into the shipped `src/tui-compiled/` bundle, and
 * this list is build/test tooling that the runtime bundle must not carry.
 */
export declare const TUI_RUNTIME_SPECIFIERS: readonly ["@opentui/core", "@opentui/core/testing", "@opentui/solid", "@opentui/solid/components", "@opentui/solid/jsx-runtime", "@opentui/solid/jsx-dev-runtime", "solid-js", "solid-js/store"];
export type TuiRuntimeSpecifier = (typeof TUI_RUNTIME_SPECIFIERS)[number];
/** Virtual module id OpenCode registers for a runtime specifier. */
export declare function runtimeModuleId(specifier: string): string;
//# sourceMappingURL=tui-runtime-specifiers.d.ts.map