import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getCurrentRuntimePackageJsonPath } from "./checker";
import { CACHE_DIR, PACKAGE_NAME } from "./constants";

interface AutoUpdateInstallContext {
    installDir: string;
    packageJsonPath: string;
}

function stripPackageNameFromPath(pathValue: string, packageName: string): string | null {
    let current = pathValue;
    for (const segment of [...packageName.split("/")].reverse()) {
        if (basename(current) !== segment) return null;
        current = dirname(current);
    }
    return current;
}

/**
 */
export function resolveInstallContext(
    runtimePackageJsonPath: string | null = getCurrentRuntimePackageJsonPath(),
): AutoUpdateInstallContext | null {
    if (runtimePackageJsonPath) {
        const packageDir = dirname(runtimePackageJsonPath);
        const nodeModulesDir = stripPackageNameFromPath(packageDir, PACKAGE_NAME);

        if (nodeModulesDir && basename(nodeModulesDir) === "node_modules") {
            const installDir = dirname(nodeModulesDir);
            const packageJsonPath = join(installDir, "package.json");
            return { installDir, packageJsonPath };
        }
        return null;
    }

    const legacyPackageJsonPath = join(dirname(CACHE_DIR), "package.json");
    if (existsSync(legacyPackageJsonPath)) {
        return { installDir: dirname(CACHE_DIR), packageJsonPath: legacyPackageJsonPath };
    }
    return null;
}
