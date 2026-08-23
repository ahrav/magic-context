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
		// Closed shape set: exactly one known provider-native output-token
		// spelling must already exist on the payload (or a Gemini-style
		// generationConfig object). Anything else is an unknown wire family
		// and the request fails closed rather than running uncapped.
		if ("max_output_tokens" in payload) {
			return { ...payload, max_output_tokens: maxOutputTokens, temperature };
		}
		if ("max_completion_tokens" in payload) {
			return { ...payload, max_completion_tokens: maxOutputTokens, temperature };
		}
		if ("max_tokens" in payload) {
			return { ...payload, max_tokens: maxOutputTokens, temperature };
		}
		if ("maxOutputTokens" in payload) {
			return { ...payload, maxOutputTokens, temperature };
		}
		if (isPlainObject(payload.generationConfig)) {
			return {
				...payload,
				generationConfig: {
					...payload.generationConfig,
					maxOutputTokens,
					temperature,
				},
			};
		}
		throw new Error(
			"broca payload hook: no recognized output-token field; refusing to send without generation controls",
		);
	});
}
