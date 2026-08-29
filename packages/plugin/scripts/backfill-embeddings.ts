#!/usr/bin/env bun
/**
 * Backfill embeddings for all memories that don't have one yet.
 *
 * Reads the user's magic-context.jsonc (same as the running plugin) to resolve
 * the active embedding provider, so this works for local MiniLM, OpenAI-
 * compatible (LMStudio/Ollama), or any other configured endpoint.
 *
 * Run: bun scripts/backfill-embeddings.ts [--directory <cwd>] [--project <project_path>]
 *   --directory  Project directory used to resolve config and identity.
 *   --project    Only backfill memories for this project_path (must match --directory identity unless --force-project-path).
 *   --shadow     Re-embed the HISTORICAL corpus under the current Synapse shadow
 *                identity instead of backfilling primary memories. Use this after
 *                a fingerprint rotation orphaned the shadow measurement cohort;
 *                it drives the same bounded enqueue path the plugin runs, but to
 *                completion with progress output.
 */
import { getMagicContextStorageDir } from '../src/shared/data-path';
import { Database } from "../src/shared/sqlite";
import { loadPluginConfig, loadPluginConfigDetailed } from "../src/config";
import {
    embedBatchForProject,
    flushShadowEmbeddingBacklog,
    getProjectEmbeddingSnapshot,
    getShadowBackfillRemaining,
    getShadowBackfillStopReason,
    registerProjectEmbedding,
    registerProjectShadowEmbedding,
} from "../src/features/magic-context/memory/embedding";
import { resolveProjectIdentity } from "../src/features/magic-context/memory/project-identity";
import { saveEmbedding } from "../src/features/magic-context/memory/storage-memory-embeddings";
import { isConfigLoadUntrusted } from "../src/plugin/embedding-bootstrap-helpers";
import { resolveEmbeddingRouting } from "../src/plugin/embedding-routing";

// Shared CortexKit database (OpenCode + Pi). The pre-v0.16 per-harness path
// (~/.local/share/opencode/storage/plugin/magic-context/) is a dead fossil on
// migrated installs — opening it silently operates on stale data with an
// ancient schema, so resolve through the same helper the plugin uses.
const DB_PATH = `${getMagicContextStorageDir()}/context.db`;
function getArg(name: string): string | null {
    const index = process.argv.indexOf(name);
    return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

/**
 * Drive the shadow historical backfill to completion with progress output.
 * Registering the (possibly rotated) shadow identity arms the backfill inside
 * the registry; this just resolves the live routing, registers both lanes the
 * same way the boot path does, then flushes the bounded queue until the missing
 * set is empty.
 */
async function runShadowBackfill(
    db: Database,
    directory: string,
    projectIdentity: string,
): Promise<void> {
    const detailed = loadPluginConfigDetailed(directory);
    if (isConfigLoadUntrusted(detailed)) {
        console.error(
            "Config load is untrusted for this project; refusing to run the shadow backfill off a config we don't trust.",
        );
        process.exitCode = 1;
        return;
    }
    const routing = await resolveEmbeddingRouting({ config: detailed.config });
    for (const warning of routing.warnings) console.warn(`[shadow] ${warning}`);
    if (!routing.shadow) {
        console.error(
            "No shadow lane is armed for this project (shadow_embedding disabled or unavailable). Nothing to do.",
        );
        return;
    }
    registerProjectEmbedding(
        db,
        projectIdentity,
        routing.primary,
        {
            memoryEnabled: detailed.config.memory.enabled,
            gitCommitEnabled: detailed.config.memory.git_commit_indexing.enabled,
        },
        directory,
    );
    registerProjectShadowEmbedding(db, projectIdentity, routing.shadow, directory);

    const before = getShadowBackfillRemaining(db, projectIdentity);
    console.log(
        `Shadow backfill for ${projectIdentity}: ${before.memory} memories, ${before.commit} commits, ${before.chunk} chunks missing under the current shadow identity.`,
    );
    if (before.memory === 0 && before.commit === 0 && before.chunk === 0) {
        console.log("Nothing to do.");
        return;
    }
    await flushShadowEmbeddingBacklog(projectIdentity, () => {
        const remaining = getShadowBackfillRemaining(db, projectIdentity);
        console.log(
            `  remaining: ${remaining.memory} memories, ${remaining.commit} commits, ${remaining.chunk} chunks`,
        );
    });
    const after = getShadowBackfillRemaining(db, projectIdentity);
    console.log(
        `Done. Embedded ${before.memory - after.memory} memories, ${before.commit - after.commit} commits, ${before.chunk - after.chunk} chunks. ` +
            `Remaining: ${after.memory} memories, ${after.commit} commits, ${after.chunk} chunks.`,
    );
    // A nonzero remaining count with a stalled stop reason is honest backlog the
    // provider failed to serve this run, not an unembeddable class — say so, and
    // say what to do, instead of leaving a bare number that reads like a bug.
    for (const scope of ["memory", "commit", "chunk"] as const) {
        if (after[scope] > 0 && getShadowBackfillStopReason(projectIdentity, scope) === "stalled_no_progress") {
            console.log(
                `  note: ${scope} stopped early after a no-progress batch (provider failure/timeout). ` +
                    `Re-run --shadow to resume; progress is banked per item.`,
            );
        }
    }
}

async function main() {
    const directory = getArg("--directory") ?? process.cwd();
    const projectFilter = getArg("--project");
    const forceProjectPath = process.argv.includes("--force-project-path");
    const projectIdentity = resolveProjectIdentity(directory);

    if (projectFilter && projectFilter !== projectIdentity && !forceProjectPath) {
        console.error(
            `--project ${projectFilter} does not match identity for --directory ${directory}: ${projectIdentity}. ` +
                "Pass --force-project-path to override.",
        );
        process.exit(1);
    }

    const db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode=WAL");

    if (process.argv.includes("--shadow")) {
        await runShadowBackfill(db, directory, projectIdentity);
        db.close();
        return;
    }

    const config = loadPluginConfig(directory);
    registerProjectEmbedding(
        db,
        projectIdentity,
        config.embedding,
        {
            memoryEnabled: config.memory.enabled,
            gitCommitEnabled: config.memory.git_commit_indexing.enabled,
        },
        directory,
    );

    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.enabled) {
        console.error("Embedding is disabled for this project.");
        db.close();
        process.exit(1);
    }

    // Find memories without embeddings for the current model (optionally filtered to one project).
    const effectiveProject = projectFilter ?? projectIdentity;
    const query = effectiveProject
        ? `SELECT m.id, m.content, m.category, m.project_path
           FROM memories m
           LEFT JOIN memory_embeddings me ON me.memory_id = m.id AND me.model_id = ?
           WHERE m.status != 'deleted' AND me.memory_id IS NULL AND m.project_path = ?`
        : `SELECT m.id, m.content, m.category, m.project_path
           FROM memories m
           LEFT JOIN memory_embeddings me ON me.memory_id = m.id AND me.model_id = ?
           WHERE m.status != 'deleted' AND me.memory_id IS NULL`;
    const stmt = db.prepare(query);
    const allMemories = (
        effectiveProject ? stmt.all(snapshot.modelId, effectiveProject) : stmt.all(snapshot.modelId)
    ) as Array<{ id: number; content: string; category: string; project_path: string }>;

    console.log(
        `Found ${allMemories.length} memories without embeddings${effectiveProject ? ` in project ${effectiveProject}` : ""}`,
    );

    if (allMemories.length === 0) {
        console.log("Nothing to do.");
        db.close();
        return;
    }

    // Batch embed for efficiency
    const batchSize = 32;
    let embedded = 0;
    let failed = 0;

    for (let i = 0; i < allMemories.length; i += batchSize) {
        const batch = allMemories.slice(i, i + batchSize);
        const texts = batch.map((m) => m.content);

        try {
            const result = await embedBatchForProject(projectIdentity, texts);
            if (!result) {
                failed += batch.length;
                continue;
            }

            for (let j = 0; j < batch.length; j++) {
                const memory = batch[j]!;
                const embedding = result.vectors[j];
                if (embedding) {
                    saveEmbedding(db, memory.id, embedding, result.modelId);
                    embedded++;
                } else {
                    console.warn(`  Failed to embed memory ${memory.id}: null result`);
                    failed++;
                }
            }
        } catch (error) {
            console.error(`  Batch ${i}-${i + batch.length} failed:`, error);
            failed += batch.length;
        }

        console.log(`  Progress: ${embedded + failed}/${allMemories.length} (${embedded} embedded, ${failed} failed)`);
    }

    // Verify
    const embeddingCount = db
        .prepare("SELECT COUNT(*) as count FROM memory_embeddings")
        .get() as { count: number };

    console.log(`\nDone. ${embedded} embeddings saved, ${failed} failures.`);
    console.log(`Total embeddings in DB: ${embeddingCount.count}`);

    db.close();
}

main().catch(console.error);
