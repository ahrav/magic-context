import {
    AUTHORITY_DOMAINS,
    type AuthorityManagedMarker,
    type AuthorityModuleClient,
    checksumAuthoritySeedRows,
    drainAuthority,
    ensureContextStoreUuid,
    getAuthorityManagedMarker,
    listAuthorityManagedMarkers,
} from "@magic-context/core/features/magic-context/context-authority";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { bumpProjectMemoryEpoch } from "@magic-context/core/features/magic-context/storage-project-state";
import { McHostModuleTransport } from "@magic-context/core/hooks/magic-context/module-transport";
import type { Database } from "@magic-context/core/shared/sqlite";

import { openExistingContextDatabaseForMutation } from "../lib/database-access";

export interface AuthorityProjectToVerify {
    /** Human-readable role in a cross-project operation, such as "source" or "target". */
    role: string;
    /** Durable Magic Context project identity stored by the authority marker. */
    projectPath: string;
    /** Filesystem root used to bind the module request to this project. */
    projectRoot: string | null;
}

export interface AuthorityVerificationResult {
    markers: AuthorityManagedMarker[];
}

export function authorityDrainCommand(project: AuthorityProjectToVerify): string {
    return `magic-context doctor drain-authority ${
        project.projectRoot ?? `<${project.role} project root>`
    }`;
}

/**
 * Prove that every requested project is writable by TypeScript before a command
 * mutates shared context.db rows. A durable authority marker is the fence: no
 * marker means TypeScript owns the project, while a marker requires the module
 * to confirm TypeScript ownership for every authority domain.
 */
export async function assertProjectsUseTsAuthority(args: {
    db: Database;
    projects: readonly AuthorityProjectToVerify[];
    module: Pick<AuthorityModuleClient, "authorityStatus">;
}): Promise<AuthorityVerificationResult> {
    const markers = listAuthorityManagedMarkers(args.db);
    const markerByProject = new Map(markers.map((marker) => [marker.project_path, marker]));

    for (const project of args.projects) {
        const marker = markerByProject.get(project.projectPath);
        if (!marker) continue;
        const projectRoot = project.projectRoot;
        if (!projectRoot) {
            throw new Error(
                `Migration refused: durable module authority for ${project.role} project ${project.projectPath} cannot be checked because its project directory is unavailable. ` +
                    `Writes remain fenced. Drain it first: ${authorityDrainCommand(project)}`,
            );
        }

        let statuses: Awaited<ReturnType<AuthorityModuleClient["authorityStatus"]>>[];
        try {
            statuses = await Promise.all(
                AUTHORITY_DOMAINS.map((domain) =>
                    args.module.authorityStatus({
                        context_store_uuid: marker.context_store_uuid,
                        project: project.projectPath,
                        projectRoot,
                        domain,
                    }),
                ),
            );
        } catch (error) {
            throw new Error(
                `Migration refused: module unreachable while checking ${project.role} project ${project.projectPath}; writes remain fenced. ` +
                    `Drain it first: ${authorityDrainCommand(project)}. ` +
                    `Module error: ${error instanceof Error ? error.message : String(error)}`,
            );
        }

        for (const [index, status] of statuses.entries()) {
            const state = status.authority?.state ?? "TS";
            if (state === "TS") continue;
            throw new Error(
                `Migration refused: ${project.role} project ${project.projectPath} has ${AUTHORITY_DOMAINS[index]} authority in ${state} mode; writes remain fenced. ` +
                    `Drain it first: ${authorityDrainCommand(project)}`,
            );
        }
    }

    return { markers };
}

function authorityClient(
    transport: McHostModuleTransport,
    projectRoot: string,
): AuthorityModuleClient {
    return {
        authorityStatus: (request) => transport.authorityStatus({ ...request, projectRoot }),
        authorityPrepare: (request) => transport.authorityPrepare({ ...request, projectRoot }),
        authorityDrain: (request) => transport.authorityDrain({ ...request, projectRoot }),
        mirrorPull: (request) => transport.mirrorPull({ ...request, projectRoot }),
    };
}

function checksumFor(
    db: Database,
    projectPath: string,
    domain: (typeof AUTHORITY_DOMAINS)[number],
): string {
    const table = domain === "memories" ? "memories" : "notes";
    const rows = db
        .prepare(`SELECT * FROM ${table} WHERE project_path = ? ORDER BY id ASC`)
        .all(projectPath)
        .filter((row): row is Record<string, unknown> => row !== null && typeof row === "object");
    return checksumAuthoritySeedRows(rows);
}

export async function reportAuthorityMarkers(args: {
    db: Database;
    info(message: string): void;
    warn(message: string): void;
}): Promise<void> {
    const markers = listAuthorityManagedMarkers(args.db);
    args.info("Authority:");
    if (markers.length === 0) {
        args.info("  no authority_managed markers");
        return;
    }

    let currentIdentity: string | undefined;
    try {
        currentIdentity = resolveProjectIdentity(process.cwd());
    } catch {
        // A doctor run must still report the durable fences when cwd identity fails.
    }
    const transport = new McHostModuleTransport();
    for (const marker of markers) {
        if (marker.project_path !== currentIdentity) {
            args.warn(
                `  ${marker.project_path}: module state unavailable outside its project root — writes fenced; run with rust mode or restore mc-host connectivity`,
            );
            continue;
        }
        try {
            const module = authorityClient(transport, process.cwd());
            const statuses = await Promise.all(
                AUTHORITY_DOMAINS.map((domain) =>
                    module.authorityStatus({
                        context_store_uuid: ensureContextStoreUuid(args.db),
                        project: marker.project_path,
                        domain,
                    }),
                ),
            );
            args.info(
                `  ${marker.project_path}: ${statuses
                    .map(
                        (status, index) =>
                            `${AUTHORITY_DOMAINS[index]}=${status.authority?.state ?? "TS"}`,
                    )
                    .join(", ")}`,
            );
        } catch {
            args.warn(
                `  ${marker.project_path}: module unreachable — writes fenced; run with rust mode or restore mc-host connectivity`,
            );
        }
    }
}

export async function runDoctorDrainAuthority(
    projectRoot: string,
    dbPath: string,
): Promise<number> {
    const db = openExistingContextDatabaseForMutation(dbPath);
    if (!db) {
        console.error("No Magic Context database found.");
        return 1;
    }
    try {
        const projectPath = resolveProjectIdentity(projectRoot);
        if (!getAuthorityManagedMarker(db, projectPath)) {
            console.log(`No authority_managed marker exists for ${projectPath}.`);
            return 0;
        }
        const module = authorityClient(new McHostModuleTransport(), projectRoot);
        let drainedAny = false;
        for (const domain of AUTHORITY_DOMAINS) {
            const status = await module.authorityStatus({
                context_store_uuid: ensureContextStoreUuid(db),
                project: projectPath,
                domain,
            });
            if (!status.authority || status.authority.state === "TS") continue;
            if (status.authority.state !== "MODULE" && status.authority.state !== "DRAINING") {
                console.error(
                    `Authority ${domain} is ${status.authority.state}; retry after it settles.`,
                );
                return 1;
            }
            let result: Awaited<ReturnType<typeof drainAuthority>> | undefined;
            for (let attempt = 0; attempt < 2; attempt += 1) {
                result = await drainAuthority({
                    db,
                    projectPath,
                    domain,
                    module,
                    checksum: () => checksumFor(db, projectPath, domain),
                });
                if (!("code" in result)) break;
            }
            if (!result || "code" in result) {
                console.error(
                    "Authority drain is contended and remains retryable; try again shortly.",
                );
                return 1;
            }
            drainedAny = true;
        }
        if (drainedAny && !getAuthorityManagedMarker(db, projectPath)) {
            bumpProjectMemoryEpoch(db, projectPath);
            console.log(`Authority drained back to TypeScript for ${projectPath}.`);
            return 0;
        }
        console.error("Module did not confirm a complete authority drain; writes remain fenced.");
        return 1;
    } catch (error) {
        console.error(
            `Module unreachable — writes fenced; run with rust mode or restore mc-host connectivity: ${error instanceof Error ? error.message : String(error)}`,
        );
        return 1;
    } finally {
        db.close();
    }
}
