import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
    type DetectDeps,
    detectOpenCode,
    detectOpenCodeInstallations,
    OPENCODE_DESKTOP_APP_IDS,
    openCodeDesktopSettingsMarkers,
} from "./opencode-detect";

const HOME = "/virt/home";

// The fixture prevents host filesystem state and installed `opencode` from affecting detection.
function deps(
    existing: Set<string>,
    platform: NodeJS.Platform = "darwin",
    onPath: (b: string) => string | null = () => null,
    executable: Set<string> = existing,
): DetectDeps {
    return {
        exists: (p) => existing.has(p),
        isExecutable: (p) => executable.has(p),
        home: HOME,
        platform,
        env: {
            APPDATA: join(HOME, "AppData", "Roaming"),
            LOCALAPPDATA: join(HOME, "AppData", "Local"),
            USERPROFILE: HOME,
            XDG_CONFIG_HOME: join(HOME, ".config"),
            XDG_DATA_HOME: join(HOME, ".local", "share"),
        },
        onPath,
    };
}

describe("detectOpenCode", () => {
    it("exposes exactly the three Desktop channel appIds", () => {
        expect([...OPENCODE_DESKTOP_APP_IDS]).toEqual([
            "ai.opencode.desktop",
            "ai.opencode.desktop.beta",
            "ai.opencode.desktop.dev",
        ]);
    });

    it("reports none when nothing OpenCode-ish exists", () => {
        expect(detectOpenCode(deps(new Set())).kind).toBe("none");
    });

    it("reports cli when the stock ~/.opencode/bin binary exists", () => {
        const bin = join(HOME, ".opencode", "bin", "opencode");
        const result = detectOpenCode(deps(new Set([bin])));
        expect(result).toEqual({ kind: "cli", binary: bin });
    });

    it("reports cli when a bare opencode is on PATH", () => {
        const pathBinary = "/somewhere/opencode";
        const result = detectOpenCode(deps(new Set([pathBinary]), "linux", () => pathBinary));
        expect(result).toEqual({ kind: "cli", binary: "/somewhere/opencode" });
    });

    it("skips a non-executable stock binary and keeps searching PATH", () => {
        const stock = join(HOME, ".opencode", "bin", "opencode");
        const pathBinary = "/somewhere/opencode";
        const result = detectOpenCode(
            deps(new Set([stock, pathBinary]), "linux", () => pathBinary, new Set([pathBinary])),
        );
        expect(result).toEqual({ kind: "cli", binary: pathBinary });
    });

    it("reports desktop when a channel's opencode.settings marker exists", () => {
        const d = deps(new Set());
        const marker = openCodeDesktopSettingsMarkers(d)[0]; // prod channel
        const result = detectOpenCode(deps(new Set([marker])));
        expect(result).toEqual({ kind: "desktop", marker });
    });

    it("reports desktop for the beta/dev channels too", () => {
        const markers = openCodeDesktopSettingsMarkers(deps(new Set()));
        for (const marker of markers) {
            expect(detectOpenCode(deps(new Set([marker]))).kind).toBe("desktop");
        }
    });

    it("reports desktop from the GUI app path when never run (no settings marker)", () => {
        const appPath = "/Applications/OpenCode.app";
        expect(detectOpenCode(deps(new Set([appPath]), "darwin")).kind).toBe("desktop");
    });

    it("does NOT treat ~/.config/opencode (shared core config) as Desktop", () => {
        const coreConfig = join(HOME, ".config", "opencode", "opencode.jsonc");
        expect(detectOpenCode(deps(new Set([coreConfig]))).kind).toBe("none");
    });

    it("enumerates PATH and home-bin installs in active priority order", () => {
        const homeBin = join(HOME, ".opencode", "bin", "opencode");
        const pathBin = "/somewhere/opencode";
        const installations = detectOpenCodeInstallations(
            deps(new Set([homeBin, pathBin]), "darwin", () => pathBin),
        );
        expect(installations).toEqual([
            { path: pathBin, source: "PATH", kind: "cli" },
            { path: homeBin, source: "home-bin", kind: "cli" },
        ]);
    });

    it("deduplicates PATH and home-bin symlink aliases by realpath", () => {
        const homeBin = join(HOME, ".opencode", "bin", "opencode");
        const pathBin = "/somewhere/opencode";
        const target = "/opt/opencode/1.18.0/opencode";
        const installations = detectOpenCodeInstallations({
            ...deps(new Set([homeBin, pathBin]), "darwin", () => pathBin),
            realpath: (path) => (path === pathBin || path === homeBin ? target : path),
        });
        expect(installations).toEqual([{ path: target, source: "PATH", kind: "cli" }]);
    });

    it("enumerates Desktop settings and GUI app probes after CLI probes", () => {
        const d = deps(new Set());
        const marker = openCodeDesktopSettingsMarkers(d)[0];
        const appPath = "/Applications/OpenCode.app";
        expect(detectOpenCodeInstallations(deps(new Set([marker, appPath]), "darwin"))).toEqual([
            { path: marker, source: "desktop", kind: "desktop" },
            { path: appPath, source: "app", kind: "desktop" },
        ]);
    });

    it("prefers cli over desktop when both are present", () => {
        const bin = join(HOME, ".opencode", "bin", "opencode");
        const marker = openCodeDesktopSettingsMarkers(deps(new Set()))[0];
        expect(detectOpenCode(deps(new Set([bin, marker]))).kind).toBe("cli");
    });

    it("finds the Windows Desktop settings marker under %APPDATA%", () => {
        const win = deps(new Set(), "win32");
        const marker = openCodeDesktopSettingsMarkers(win)[0];
        expect(marker).toBe(
            join(HOME, "AppData", "Roaming", "ai.opencode.desktop", "opencode.settings"),
        );
        expect(detectOpenCode(deps(new Set([marker]), "win32")).kind).toBe("desktop");
    });
});
