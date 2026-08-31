import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import Ajv2020 from "ajv/dist/2020";

const MANIFEST_SCHEMA =
	"magic-context.secret-scanner-qualification-manifest/v1";
const RECEIPT_SCHEMA = "magic-context.secret-scanner-qualification/v1";
const RESULT_SCHEMA = "magic-context.secret-scanner-artifact-result/v1";
const IDENTITY_SCHEMA = "magic-context.secret-scanner-artifact-identity/v1";
const REQUIRED_QUOTA = 300_000;
const MINIMUM_FEASIBLE_CELL_QUOTA = 10_000;
const SIZE_CLASSES = [
	"0_256",
	"257_4096",
	"4097_65536",
	"65537_524288",
] as const;
const DENSITY_CLASSES = ["0", "1_8", "9_64", "65_plus"] as const;
const FEASIBILITIES = ["feasible", "impossible", "unassessed"] as const;
const MODES = ["legacy_comparison", "new_authority_legacy_shadow"] as const;
const DIVERGENCES = [
	"match",
	"legacy_only",
	"portable_only",
	"different_output",
	"portable_error",
] as const;

type SizeClass = (typeof SIZE_CLASSES)[number];
type DensityClass = (typeof DENSITY_CLASSES)[number];
type Feasibility = (typeof FEASIBILITIES)[number];
type Mode = (typeof MODES)[number];
type Divergence = (typeof DIVERGENCES)[number];

interface Cell {
	cell_id: string;
	size_class: SizeClass;
	finding_density: DensityClass;
	feasibility: Feasibility;
	quota: number;
}

interface Manifest {
	schema: typeof MANIFEST_SCHEMA;
	status: "tooling_only" | "frozen";
	authority_qualified: false;
	mode: Mode;
	fixture: string;
	fixture_sha256: string;
	fixture_cases: number;
	planned_scan_quota: number;
	operational_review_complete: boolean;
	production_divergence_classes_reproduced: boolean;
	cells: Cell[];
	note: string;
}

interface Fixture {
	case_id: string;
	cell_id: string;
	input: string;
	expected_rule_ids: string[];
	expected_divergence: Divergence;
	consent: "synthetic" | "explicit";
}

interface ArtifactResult {
	schema: typeof RESULT_SCHEMA;
	case_id: string;
	attempted: number;
	completed: number;
	rejected: number;
	scanner_failures: number;
	incomplete_reports: number;
	invalid_spans: number;
	observed_finding_count: number;
	observed_rule_ids: string[];
	divergences: Record<Divergence, number>;
	elapsed_ns: number;
}

interface Options {
	artifact: string;
	manifest: string;
	outRoot: string;
	seed: number;
	dryRun: boolean;
}

function fail(message: string): never {
	throw new Error(`secret-scanner qualification: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
	label: string,
): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
		fail(`${label} keys do not match schema`);
	}
}

function member<T extends string>(
	value: unknown,
	values: readonly T[],
	label: string,
): T {
	if (typeof value !== "string" || !values.includes(value as T))
		fail(`invalid ${label}`);
	return value as T;
}

function integer(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		fail(`invalid ${label}`);
	}
	return value;
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) fail(`invalid ${label}`);
	return value;
}

function digest(value: unknown, label: string): string {
	const result = text(value, label);
	if (!/^[0-9a-f]{64}$/.test(result)) fail(`invalid ${label}`);
	return result;
}

function parseManifest(value: unknown): Manifest {
	if (!isRecord(value)) fail("manifest must be an object");
	exactKeys(
		value,
		[
			"schema",
			"status",
			"authority_qualified",
			"mode",
			"fixture",
			"fixture_sha256",
			"fixture_cases",
			"planned_scan_quota",
			"operational_review_complete",
			"production_divergence_classes_reproduced",
			"cells",
			"note",
		],
		"manifest",
	);
	if (value.schema !== MANIFEST_SCHEMA) fail("unsupported manifest schema");
	if (value.status !== "tooling_only" && value.status !== "frozen")
		fail("invalid manifest status");
	if (value.authority_qualified !== false)
		fail("input manifest cannot claim qualification");
	if (typeof value.operational_review_complete !== "boolean")
		fail("invalid operational review flag");
	if (typeof value.production_divergence_classes_reproduced !== "boolean") {
		fail("invalid production divergence flag");
	}
	if (!Array.isArray(value.cells)) fail("manifest cells must be an array");
	const cells = value.cells.map((candidate, index): Cell => {
		if (!isRecord(candidate)) fail(`cell ${index} must be an object`);
		exactKeys(
			candidate,
			["cell_id", "size_class", "finding_density", "feasibility", "quota"],
			`cell ${index}`,
		);
		return {
			cell_id: text(candidate.cell_id, `cell ${index} id`),
			size_class: member(
				candidate.size_class,
				SIZE_CLASSES,
				`cell ${index} size class`,
			),
			finding_density: member(
				candidate.finding_density,
				DENSITY_CLASSES,
				`cell ${index} density class`,
			),
			feasibility: member(
				candidate.feasibility,
				FEASIBILITIES,
				`cell ${index} feasibility`,
			),
			quota: integer(candidate.quota, `cell ${index} quota`),
		};
	});
	const expectedCells = new Set(
		SIZE_CLASSES.flatMap((size) =>
			DENSITY_CLASSES.map((density) => `${size}:${density}`),
		),
	);
	for (const cell of cells) {
		const key = `${cell.size_class}:${cell.finding_density}`;
		if (!expectedCells.delete(key))
			fail("duplicate or unknown qualification cell");
	}
	if (expectedCells.size !== 0) fail("qualification matrix is incomplete");
	return {
		schema: MANIFEST_SCHEMA,
		status: value.status,
		authority_qualified: false,
		mode: member(value.mode, MODES, "manifest mode"),
		fixture: text(value.fixture, "fixture path"),
		fixture_sha256: digest(value.fixture_sha256, "fixture digest"),
		fixture_cases: integer(value.fixture_cases, "fixture case count"),
		planned_scan_quota: integer(value.planned_scan_quota, "planned scan quota"),
		operational_review_complete: value.operational_review_complete,
		production_divergence_classes_reproduced:
			value.production_divergence_classes_reproduced,
		cells,
		note: text(value.note, "manifest note"),
	};
}

function parseFixture(line: string, index: number): Fixture {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		fail(`fixture line ${index} is not JSON`);
	}
	if (!isRecord(value)) fail(`fixture line ${index} must be an object`);
	exactKeys(
		value,
		[
			"case_id",
			"cell_id",
			"input",
			"expected_rule_ids",
			"expected_divergence",
			"consent",
		],
		`fixture line ${index}`,
	);
	if (!Array.isArray(value.expected_rule_ids))
		fail(`fixture line ${index} has invalid expected rule IDs`);
	if (typeof value.input !== "string")
		fail(`fixture line ${index} input is invalid`);
	const expectedRuleIds = value.expected_rule_ids.map((rule, ruleIndex) =>
		text(rule, `fixture line ${index} rule ${ruleIndex}`),
	);
	if (new Set(expectedRuleIds).size !== expectedRuleIds.length) {
		fail(`fixture line ${index} has duplicate expected rule IDs`);
	}
	return {
		case_id: text(value.case_id, `fixture line ${index} case ID`),
		cell_id: text(value.cell_id, `fixture line ${index} cell ID`),
		input: value.input,
		expected_rule_ids: expectedRuleIds,
		expected_divergence: member(
			value.expected_divergence,
			DIVERGENCES,
			`fixture line ${index} divergence`,
		),
		consent: member(
			value.consent,
			["synthetic", "explicit"] as const,
			`fixture line ${index} consent`,
		),
	};
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function parseOptions(args: string[]): Options {
	let artifact: string | undefined;
	let manifest: string | undefined;
	let outRoot = "docs/evidence/secret-scanner";
	let seed: number | undefined;
	let dryRun = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		const value = args[index + 1];
		if (value === undefined) fail(`missing value for ${arg}`);
		index += 1;
		if (arg === "--artifact") artifact = value;
		else if (arg === "--manifest") manifest = value;
		else if (arg === "--out-root") outRoot = value;
		else if (arg === "--seed") seed = integer(Number(value), "seed");
		else fail(`unknown argument ${arg}`);
	}
	if (artifact === undefined) fail("--artifact is required");
	if (manifest === undefined) fail("--manifest is required");
	if (seed === undefined) fail("--seed is required");
	return { artifact, manifest, outRoot, seed, dryRun };
}

function executable(path: string): string {
	if (!existsSync(path)) fail("artifact does not exist");
	const stat = lstatSync(path);
	if (!stat.isFile()) fail("artifact is not a regular file");
	if (process.platform !== "win32" && (stat.mode & 0o111) === 0) {
		fail("artifact is not executable");
	}
	return realpathSync(path);
}

function artifactIdentity(artifact: string): Record<string, unknown> {
	const result = Bun.spawnSync([artifact, "--identity"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) fail("artifact identity probe failed");
	let identity: unknown;
	try {
		identity = JSON.parse(result.stdout.toString());
	} catch {
		fail("artifact identity is not JSON");
	}
	if (!isRecord(identity) || identity.schema !== IDENTITY_SCHEMA) {
		fail("artifact identity schema is invalid");
	}
	exactKeys(
		identity,
		[
			"schema",
			"crate_version",
			"semantic_digest",
			"semantic_digest_version",
			"upstream_commit",
		],
		"artifact identity",
	);
	digest(identity.semantic_digest, "artifact semantic digest");
	text(identity.crate_version, "artifact crate version");
	const upstreamCommit = text(
		identity.upstream_commit,
		"artifact upstream commit",
	);
	if (!/^[0-9a-f]{40}$/.test(upstreamCommit)) {
		fail("invalid artifact upstream commit");
	}
	if (
		integer(
			identity.semantic_digest_version,
			"artifact semantic digest version",
		) < 1
	) {
		fail("invalid artifact semantic digest version");
	}
	return identity;
}

function nextRandom(state: { value: number }): number {
	let value = state.value | 0;
	value ^= value << 13;
	value ^= value >>> 17;
	value ^= value << 5;
	state.value = value >>> 0;
	return state.value;
}

function commands(
	manifest: Manifest,
	fixtures: Fixture[],
	seed: number,
): string {
	const byCell = new Map<string, Fixture[]>();
	for (const fixture of fixtures) {
		const list = byCell.get(fixture.cell_id) ?? [];
		list.push(fixture);
		byCell.set(fixture.cell_id, list);
	}
	const state = { value: seed >>> 0 || 1 };
	const lines: string[] = [];
	for (const cell of manifest.cells) {
		if (cell.quota === 0) continue;
		const candidates = byCell.get(cell.cell_id);
		if (candidates === undefined || candidates.length === 0) {
			fail(`cell ${cell.cell_id} has quota but no fixture`);
		}
		if (cell.quota < candidates.length) {
			fail(`cell ${cell.cell_id} quota cannot exercise every fixture`);
		}
		const counts = new Array<number>(candidates.length).fill(1);
		for (let index = candidates.length; index < cell.quota; index += 1) {
			counts[nextRandom(state) % candidates.length] += 1;
		}
		for (let index = 0; index < candidates.length; index += 1) {
			const repetitions = counts[index];
			if (repetitions === 0) continue;
			const fixture = candidates[index];
			lines.push(
				JSON.stringify({
					case_id: fixture.case_id,
					input: fixture.input,
					repetitions,
					mode: manifest.mode,
				}),
			);
		}
	}
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function parseResult(line: string): ArtifactResult {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		fail("artifact result is not JSON");
	}
	if (
		!isRecord(value) ||
		value.schema !== RESULT_SCHEMA ||
		!isRecord(value.divergences)
	) {
		fail("artifact result schema is invalid");
	}
	const divergences = Object.fromEntries(
		DIVERGENCES.map((name) => [
			name,
			integer(value.divergences[name], `divergence ${name}`),
		]),
	) as Record<Divergence, number>;
	if (!Array.isArray(value.observed_rule_ids))
		fail("artifact rule IDs are invalid");
	const observedRuleIds = value.observed_rule_ids.map((rule, index) =>
		text(rule, `artifact rule ${index}`),
	);
	if (new Set(observedRuleIds).size !== observedRuleIds.length) {
		fail("artifact rule IDs contain duplicates");
	}
	return {
		schema: RESULT_SCHEMA,
		case_id: text(value.case_id, "artifact case ID"),
		attempted: integer(value.attempted, "artifact attempted count"),
		completed: integer(value.completed, "artifact completed count"),
		rejected: integer(value.rejected, "artifact rejected count"),
		scanner_failures: integer(
			value.scanner_failures,
			"artifact scanner failures",
		),
		incomplete_reports: integer(
			value.incomplete_reports,
			"artifact incomplete reports",
		),
		invalid_spans: integer(value.invalid_spans, "artifact invalid spans"),
		observed_finding_count: integer(
			value.observed_finding_count,
			"artifact finding count",
		),
		observed_rule_ids: observedRuleIds,
		divergences,
		elapsed_ns: integer(value.elapsed_ns, "artifact elapsed time"),
	};
}

function validateReceipt(
	receipt: Record<string, unknown>,
	schema: Record<string, unknown>,
): void {
	if (schema.$id !== RECEIPT_SCHEMA) fail("receipt schema file is invalid");
	const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
		schema,
	);
	if (!validate(receipt)) {
		fail(`receipt does not match schema: ${JSON.stringify(validate.errors)}`);
	}
}

function sizeClass(bytes: number): SizeClass | undefined {
	if (bytes <= 256) return "0_256";
	if (bytes <= 4096) return "257_4096";
	if (bytes <= 65_536) return "4097_65536";
	if (bytes <= 524_288) return "65537_524288";
	return undefined;
}

function densityClass(findings: number): DensityClass {
	if (findings === 0) return "0";
	if (findings <= 8) return "1_8";
	if (findings <= 64) return "9_64";
	return "65_plus";
}

function main(): void {
	const options = parseOptions(process.argv.slice(2));
	const artifact = executable(resolve(options.artifact));
	const artifactBytes = readFileSync(artifact);
	const artifactSha256 = sha256(artifactBytes);
	const identity = artifactIdentity(artifact);
	const manifestPath = resolve(options.manifest);
	const manifestBytes = readFileSync(manifestPath);
	const manifest = parseManifest(JSON.parse(manifestBytes.toString("utf8")));
	const fixturePath = isAbsolute(manifest.fixture)
		? manifest.fixture
		: resolve(dirname(manifestPath), manifest.fixture);
	const fixtureBytes = readFileSync(fixturePath);
	if (sha256(fixtureBytes) !== manifest.fixture_sha256)
		fail("fixture digest mismatch");
	const fixtureLines = fixtureBytes
		.toString("utf8")
		.split(/\r?\n/u)
		.filter((line) => line.length > 0);
	const fixtures = fixtureLines.map(parseFixture);
	if (fixtures.length !== manifest.fixture_cases)
		fail("fixture case count mismatch");
	const caseIds = new Set<string>();
	for (const fixture of fixtures) {
		const cell = manifest.cells.find(
			(candidate) => candidate.cell_id === fixture.cell_id,
		);
		if (cell === undefined) fail("fixture references unknown cell");
		if (
			sizeClass(Buffer.byteLength(fixture.input, "utf8")) !== cell.size_class
		) {
			fail("fixture size class does not match its cell");
		}
		if (caseIds.has(fixture.case_id)) fail("duplicate fixture case ID");
		caseIds.add(fixture.case_id);
	}

	const input = commands(manifest, fixtures, options.seed);
	const started = Bun.nanoseconds();
	const execution = Bun.spawnSync([artifact], {
		stdin: new TextEncoder().encode(input),
		stdout: "pipe",
		stderr: "pipe",
	});
	const wallNs = Bun.nanoseconds() - started;
	if (execution.exitCode !== 0) fail("artifact campaign failed");
	const results = execution.stdout
		.toString()
		.split(/\r?\n/u)
		.filter((line) => line.length > 0)
		.map(parseResult);
	const fixtureById = new Map(
		fixtures.map((fixture) => [fixture.case_id, fixture]),
	);
	const observedCaseIds = new Set(results.map((result) => result.case_id));
	const cellResults = new Map(
		manifest.cells.map((cell) => [
			cell.cell_id,
			{
				cell_id: cell.cell_id,
				size_class: cell.size_class,
				finding_density: cell.finding_density,
				feasibility: cell.feasibility,
				quota: cell.quota,
				attempted: 0,
				completed: 0,
				rejected: 0,
				scanner_failures: 0,
				incomplete_reports: 0,
				invalid_spans: 0,
				divergences: Object.fromEntries(
					DIVERGENCES.map((name) => [name, 0]),
				) as Record<Divergence, number>,
				elapsed_ns: 0,
			},
		]),
	);
	let fixtureMismatch = false;
	for (const result of results) {
		const fixture = fixtureById.get(result.case_id);
		if (fixture === undefined) fail("artifact returned unknown case ID");
		const expectedRuleIds = [...fixture.expected_rule_ids].sort();
		const observedRuleIds = [...result.observed_rule_ids].sort();
		if (canonical(expectedRuleIds) !== canonical(observedRuleIds)) {
			fixtureMismatch = true;
		}
		const manifestCell = manifest.cells.find(
			(candidate) => candidate.cell_id === fixture.cell_id,
		);
		if (
			manifestCell === undefined ||
			densityClass(result.observed_finding_count) !==
				manifestCell.finding_density
		) {
			fixtureMismatch = true;
		}
		for (const divergence of DIVERGENCES) {
			if (
				divergence !== fixture.expected_divergence &&
				result.divergences[divergence] !== 0
			) {
				fixtureMismatch = true;
			}
		}
		if (result.divergences[fixture.expected_divergence] !== result.attempted) {
			fixtureMismatch = true;
		}
		const cell = cellResults.get(fixture.cell_id);
		if (cell === undefined) fail("fixture result references unknown cell");
		cell.attempted += result.attempted;
		cell.completed += result.completed;
		cell.rejected += result.rejected;
		cell.scanner_failures += result.scanner_failures;
		cell.incomplete_reports += result.incomplete_reports;
		cell.invalid_spans += result.invalid_spans;
		cell.elapsed_ns += result.elapsed_ns;
		for (const divergence of DIVERGENCES) {
			cell.divergences[divergence] += result.divergences[divergence];
		}
	}
	const cells = [...cellResults.values()];
	const sum = (field: keyof (typeof cells)[number]): number =>
		cells.reduce(
			(total, cell) =>
				total + (typeof cell[field] === "number" ? cell[field] : 0),
			0,
		);
	const quotaSum = manifest.cells.reduce(
		(total, cell) => total + cell.quota,
		0,
	);
	const matrixAssessed = manifest.cells.every(
		(cell) => cell.feasibility !== "unassessed",
	);
	const feasibleMinimum = manifest.cells
		.filter((cell) => cell.feasibility === "feasible")
		.every((cell) => cell.quota >= MINIMUM_FEASIBLE_CELL_QUOTA);
	const impossibleZero = manifest.cells
		.filter((cell) => cell.feasibility === "impossible")
		.every((cell) => cell.quota === 0);
	const attemptedMatches = manifest.cells.every(
		(cell) => cellResults.get(cell.cell_id)?.attempted === cell.quota,
	);
	const expectedCaseIds = fixtures
		.filter((fixture) => {
			const cell = manifest.cells.find(
				(candidate) => candidate.cell_id === fixture.cell_id,
			);
			return cell !== undefined && cell.quota > 0;
		})
		.map((fixture) => fixture.case_id);
	const fixturesMatch =
		manifest.planned_scan_quota > 0 &&
		!fixtureMismatch &&
		expectedCaseIds.every((caseId) => observedCaseIds.has(caseId));
	const failures =
		sum("scanner_failures") + sum("incomplete_reports") + sum("invalid_spans");
	const gates = {
		candidate_authority_mode: manifest.mode === "new_authority_legacy_shadow",
		matrix_assessed: matrixAssessed,
		quota_sum_300000:
			quotaSum === REQUIRED_QUOTA && manifest.planned_scan_quota === quotaSum,
		feasible_cell_minimum_10000: feasibleMinimum,
		impossible_cells_have_zero_quota: impossibleZero,
		attempted_matches_manifest: attemptedMatches,
		fixtures_match: fixturesMatch,
		zero_scanner_failures: failures === 0,
		operational_review_complete: manifest.operational_review_complete,
		production_divergence_classes_reproduced:
			manifest.production_divergence_classes_reproduced,
	};
	const qualified =
		Object.values(gates).every(Boolean) && manifest.status === "frozen";
	const receipt: Record<string, unknown> = {
		schema: RECEIPT_SCHEMA,
		artifact: {
			file_name: basename(artifact),
			sha256: artifactSha256,
			bytes: artifactBytes.length,
			identity,
		},
		manifest: {
			file: relative(process.cwd(), manifestPath),
			sha256: sha256(manifestBytes),
			fixture_sha256: manifest.fixture_sha256,
			planned_scan_quota: manifest.planned_scan_quota,
			status: manifest.status,
			mode: manifest.mode,
		},
		seed: options.seed,
		cells,
		totals: {
			attempted: sum("attempted"),
			completed: sum("completed"),
			rejected: sum("rejected"),
			scanner_failures: sum("scanner_failures"),
			incomplete_reports: sum("incomplete_reports"),
			invalid_spans: sum("invalid_spans"),
			divergences: Object.fromEntries(
				DIVERGENCES.map((name) => [
					name,
					cells.reduce((total, cell) => total + cell.divergences[name], 0),
				]),
			),
		},
		timings: {
			wall_ns: wallNs,
			artifact_elapsed_ns: sum("elapsed_ns"),
		},
		gates,
		authority_verdict: qualified ? "qualified" : "refused",
	};
	const schemaPath = resolve(
		"docs/schemas/secret-scanner-qualification-v1.schema.json",
	);
	const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<
		string,
		unknown
	>;
	validateReceipt(receipt, schema);
	if (options.dryRun) {
		console.log(
			`secret-scanner qualification dry run: artifact ${artifactSha256}, authority ${receipt.authority_verdict}`,
		);
		return;
	}
	const outputDirectory = join(resolve(options.outRoot), artifactSha256);
	mkdirSync(outputDirectory, { recursive: true });
	const output = join(outputDirectory, "qualification-v1.json");
	writeFileSync(output, `${canonical(receipt)}\n`, { flag: "wx", mode: 0o600 });
	chmodSync(output, 0o600);
	console.log(`${output}: authority ${receipt.authority_verdict}`);
}

if (import.meta.main) {
	try {
		main();
	} catch (error) {
		console.error(
			error instanceof Error
				? error.message
				: "secret-scanner qualification failed",
		);
		process.exitCode = 1;
	}
}
