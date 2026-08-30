import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	_resetProjectEmbeddingRegistryForTests,
	getProjectEmbeddingSnapshot,
} from "@magic-context/core/features/magic-context/memory/embedding";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { ensureProjectRegisteredFromPiDirectory } from "./embedding-bootstrap";
import { createTestDb } from "./test-utils";

describe("ensureProjectRegisteredFromPiDirectory", () => {
	it("registers Synapse as deferred intent without persisting a pending lane", async () => {
		const db = createTestDb();
		const oldHome = process.env.HOME;
		const oldConfigHome = process.env.XDG_CONFIG_HOME;
		const directory = mkdtempSync(join(tmpdir(), "pi-synapse-bootstrap-"));
		const fakeHome = mkdtempSync(join(tmpdir(), "pi-synapse-home-"));
		process.env.HOME = fakeHome;
		process.env.XDG_CONFIG_HOME = join(fakeHome, ".config");
		const configDir = join(fakeHome, ".config", "cortexkit");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "magic-context.json"),
			JSON.stringify({
				embedding: { provider: "synapse", fallback_provider: "off" },
			}),
		);
		try {
			const projectIdentity = resolveProjectIdentity(directory);
			await ensureProjectRegisteredFromPiDirectory(directory, db);

			expect(
				getProjectEmbeddingSnapshot(projectIdentity)?.providerIdentity,
			).not.toContain("pending");
			expect(
				db
					.prepare(
						"SELECT provider_identity FROM embedding_registrations WHERE project_path = ?",
					)
					.get(projectIdentity),
			).toBeNull();
		} finally {
			_resetProjectEmbeddingRegistryForTests();
			if (oldHome === undefined) delete process.env.HOME;
			else process.env.HOME = oldHome;
			if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = oldConfigHome;
			rmSync(directory, { recursive: true, force: true });
			rmSync(fakeHome, { recursive: true, force: true });
			closeQuietly(db);
		}
	});
});
