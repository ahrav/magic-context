import { statSync } from "node:fs";
import {
	cortexKitProjectConfigBasePath,
	cortexKitUserConfigBasePath,
} from "@magic-context/core/config/migrate-config-location";
import {
	type EmbeddingFeatures,
	registerProjectEmbedding,
	registerProjectShadowEmbedding,
} from "@magic-context/core/features/magic-context/memory/embedding";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	handleUntrustedLoad,
	isConfigLoadUntrusted,
} from "@magic-context/core/plugin/embedding-bootstrap-helpers";
import { resolveEmbeddingRouting } from "@magic-context/core/plugin/embedding-routing";
import { log } from "@magic-context/core/shared/logger";
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

	if (isConfigLoadUntrusted(detailed)) {
		handleUntrustedLoad(db, projectIdentity, directory, detailed);
		return;
	}

	const features: EmbeddingFeatures = {
		memoryEnabled: detailed.config.memory.enabled,
		gitCommitEnabled: detailed.config.memory.git_commit_indexing.enabled,
	};
	const routing = await resolveEmbeddingRouting({ config: detailed.config });
	for (const warning of routing.warnings) {
		log(`[magic-context][pi] ${warning}`);
	}
	registerProjectEmbedding(
		db,
		projectIdentity,
		routing.primary,
		features,
		directory,
	);
	if (routing.shadow) {
		registerProjectShadowEmbedding(
			db,
			projectIdentity,
			routing.shadow,
			directory,
		);
	}
	const fingerprintPaths = configCandidatePaths(
		directory,
		detailed.loadedFromPaths,
	);
	registrationFingerprints.set(projectIdentity, {
		paths: fingerprintPaths,
		fingerprint: configFingerprint(fingerprintPaths),
	});
}
