import type { Database } from "../../../shared/sqlite";

export interface MuralManifestRow {
    projectPath: string;
    image: Buffer;
    contentHash: string;
    renderedAt: number;
    model: string | null;
    memoryIds: string[];
    width: number;
    height: number;
}

interface RawMuralRow {
    project_path: string;
    image: Buffer | Uint8Array;
    content_hash: string;
    rendered_at: number;
    model: string | null;
    memory_ids_json: string;
    width: number;
    height: number;
}

export function getMural(db: Database, projectPath: string): MuralManifestRow | null {
    try {
        const row = db
            .prepare<[string], RawMuralRow>(
                "SELECT project_path, image, content_hash, rendered_at, model, memory_ids_json, width, height FROM mural_manifest WHERE project_path = ?",
            )
            .get(projectPath);
        if (!row) return null;
        let memoryIds: string[] = [];
        try {
            const parsed = JSON.parse(row.memory_ids_json);
            if (Array.isArray(parsed))
                memoryIds = parsed.filter((id): id is string => typeof id === "string");
        } catch {
            // A malformed sidecar must not make m0 injection fail closed.
        }
        return {
            projectPath: row.project_path,
            image: Buffer.from(row.image),
            contentHash: row.content_hash,
            renderedAt: row.rendered_at,
            model: row.model,
            memoryIds,
            width: row.width,
            height: row.height,
        };
    } catch (error) {
        if (String(error).includes("no such table")) return null;
        throw error;
    }
}

export function upsertMural(
    db: Database,
    input: Omit<MuralManifestRow, "projectPath"> & { projectPath: string },
): void {
    db.prepare(
        "INSERT INTO mural_manifest (project_path, image, content_hash, rendered_at, model, memory_ids_json, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_path) DO UPDATE SET image = excluded.image, content_hash = excluded.content_hash, rendered_at = excluded.rendered_at, model = excluded.model, memory_ids_json = excluded.memory_ids_json, width = excluded.width, height = excluded.height",
    ).run(
        input.projectPath,
        input.image,
        input.contentHash,
        input.renderedAt,
        input.model,
        JSON.stringify(input.memoryIds),
        input.width,
        input.height,
    );
}
