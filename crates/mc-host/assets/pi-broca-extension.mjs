// Bundled Broca payload hook (KTD8, R16-R18).
//
// Loaded LAST via an explicit `--extension` flag so it runs after every
// trusted daemon-owner provider extension in Pi's load-ordered
// `before_provider_request` chain: whatever an earlier extension did to the
// payload, this hook owns the final generation contract.
//
// It REPLACES the provider-native output-token and temperature fields with
// the values requested through Broca's `session.send`, preserves every
// unrelated payload field, and REJECTS (throws, failing the request)
// payload shapes it does not recognize — silently dropping generation
// controls would let a provider default exceed the caller's budget.
//
// The requested values arrive through two adapter-owned environment
// variables set by mc-host's Pi backend; they are plain bounded numbers,
// never prompt or credential material.

const MAX_OUTPUT_TOKENS_ENV = "MC_BROCA_MAX_OUTPUT_TOKENS";
const TEMPERATURE_ENV = "MC_BROCA_TEMPERATURE";

function requiredNumber(name) {
	const raw = process.env[name];
	const value = Number(raw);
	if (raw === undefined || raw === "" || !Number.isFinite(value)) {
		throw new Error(`broca payload hook: missing or invalid ${name}`);
	}
	return value;
}

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function (pi) {
	pi.on("before_provider_request", (event) => {
		const maxOutputTokens = requiredNumber(MAX_OUTPUT_TOKENS_ENV);
		const temperature = requiredNumber(TEMPERATURE_ENV);
		const payload = event.payload;
		if (!isPlainObject(payload)) {
			throw new Error("broca payload hook: unsupported provider payload shape");
		}
		// Closed shape set: at least one known provider-native output-token
		// spelling must already exist on the payload (or a Gemini-style
		// generationConfig object). Anything else is an unknown wire family
		// and the request fails closed rather than running uncapped. Every
		// recognized spelling that is present gets rewritten — an earlier
		// extension can leave more than one (say `max_completion_tokens`
		// plus `max_tokens`), and rewriting only the first would preserve a
		// larger limit in the field the provider actually honors.
		const spellings = [
			"max_output_tokens",
			"max_completion_tokens",
			"max_tokens",
			"maxOutputTokens",
		].filter((name) => name in payload);
		const generationConfig = isPlainObject(payload.generationConfig)
			? payload.generationConfig
			: null;
		if (spellings.length === 0 && generationConfig === null) {
			throw new Error(
				"broca payload hook: no recognized output-token field; refusing to send without generation controls",
			);
		}
		const next = { ...payload };
		for (const name of spellings) {
			next[name] = maxOutputTokens;
		}
		if (spellings.length > 0) {
			next.temperature = temperature;
		}
		if (generationConfig !== null) {
			next.generationConfig = {
				...generationConfig,
				maxOutputTokens,
				temperature,
			};
		}
		return next;
	});
}
