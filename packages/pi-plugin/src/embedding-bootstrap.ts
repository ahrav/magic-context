import { statSync } from "node:fs";
import {
	cortexKitProjectConfigBasePath,
	cortexKitUserConfigBasePath,
} from "@magic-context/core/config/migrate-config-location";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { registerProjectEmbeddingFromDetailedLoad } from "@magic-context/core/plugin/embedding-bootstrap";
import { loadPiConfigDetailed } from "./config";

interface RegistrationFingerprint {
	paths: string[];
	fingerprint: string;
}

const registrationFingerprintsByDatabase = new WeakMap<
	object,
	Map<string, RegistrationFingerprint>
>();

function configCandidatePaths(
	directory: string,
	loadedPaths: readonly string[],
): string[] {
	const projectBase = cortexKitProjectConfigBasePath(directory);
	const userBase = cortexKitUserConfigBasePath();
	return [
		`${projectBase}.jsonc`,
		`${projectBase}.json`,
		`${userBase}.jsonc`,
		`${userBase}.json`,
		...loadedPaths,
	].filter((path, index, paths) => paths.indexOf(path) === index);
}

function configFingerprint(paths: readonly string[]): string {
	return paths
		.map((path) => {
			try {
				const stat = statSync(path);
				return `${path}:${stat.size}:${stat.mtimeMs}`;
			} catch {
				return `${path}:missing`;
			}
		})
		.join("|");
}

export async function ensureProjectRegisteredFromPiDirectory(
	directory: string,
	db: ContextDatabase,
): Promise<void> {
	const detailed = loadPiConfigDetailed({ cwd: directory });
	const projectIdentity = resolveProjectIdentityForSession(
		directory,
		detailed.config.allow_home_project,
	);
	if (!projectIdentity) return;
	let registrationFingerprints = registrationFingerprintsByDatabase.get(db);
	if (!registrationFingerprints) {
		registrationFingerprints = new Map();
		registrationFingerprintsByDatabase.set(db, registrationFingerprints);
	}
	const cached = registrationFingerprints.get(projectIdentity);
	if (cached && configFingerprint(cached.paths) === cached.fingerprint) return;

	const registered = await registerProjectEmbeddingFromDetailedLoad({
		db,
		directory,
		projectIdentity,
		detailed,
		logPrefix: "[magic-context][pi]",
	});
	if (!registered) return;

	const fingerprintPaths = configCandidatePaths(
		directory,
		detailed.loadedFromPaths,
	);
	registrationFingerprints.set(projectIdentity, {
		paths: fingerprintPaths,
		fingerprint: configFingerprint(fingerprintPaths),
	});
}
