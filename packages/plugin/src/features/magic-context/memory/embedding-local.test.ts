import { describe, expect, test } from "bun:test";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../../../config/schema/magic-context";
import { getEmbeddingProviderIdentity } from "./embedding-identity";
import {
    getLocalEmbeddingRecipe,
    isNativeRuntimeMissingError,
    type LocalEmbeddingDtype,
    LocalEmbeddingProvider,
} from "./embedding-local";
import { computeNormalizedHash } from "./normalize-hash";

// When the native runtime is missing, the provider degrades once and emits one log line.
// The provider must not retry importing Transformers or repeat the resolver error for each embedding.
// The discriminator must recognize missing-package errors without classifying transient or unrelated load errors as missing runtime.
describe("isNativeRuntimeMissingError", () => {
    test("Bun resolver: Cannot find package 'onnxruntime-node'", () => {
        expect(
            isNativeRuntimeMissingError(new Error("Cannot find package 'onnxruntime-node'")),
        ).toBe(true);
    });

    test("Node ERR_MODULE_NOT_FOUND targeting onnxruntime-node", () => {
        const err = Object.assign(new Error("Cannot find module 'onnxruntime-node'"), {
            code: "ERR_MODULE_NOT_FOUND",
        });
        expect(isNativeRuntimeMissingError(err)).toBe(true);
    });

    test("Bun ResolveMessage name on onnxruntime-node", () => {
        const err = Object.assign(new Error("Could not resolve: onnxruntime-node"), {
            name: "ResolveMessage",
        });
        expect(isNativeRuntimeMissingError(err)).toBe(true);
    });

    test("transient protobuf parse failure is NOT classified as missing-runtime", () => {
        expect(isNativeRuntimeMissingError(new Error("Protobuf parsing failed"))).toBe(false);
    });

    test("EBUSY transient is NOT missing-runtime", () => {
        expect(isNativeRuntimeMissingError(new Error("EBUSY: resource busy"))).toBe(false);
    });

    test("unrelated error mentioning neither package nor module is not missing-runtime", () => {
        expect(isNativeRuntimeMissingError(new Error("model file checksum mismatch"))).toBe(false);
    });

    test("a generic 'cannot find module' for some OTHER package is not our runtime", () => {
        const err = Object.assign(new Error("Cannot find package 'left-pad'"), {
            code: "ERR_MODULE_NOT_FOUND",
        });
        expect(isNativeRuntimeMissingError(err)).toBe(false);
    });

    test("null/undefined/non-error inputs are safe", () => {
        expect(isNativeRuntimeMissingError(null)).toBe(false);
        expect(isNativeRuntimeMissingError(undefined)).toBe(false);
        expect(isNativeRuntimeMissingError("onnxruntime-node")).toBe(false);
    });

    // A native binding load failure can use `ERR_DLOPEN_FAILED` and name `onnxruntime` rather than `onnxruntime-node`.
    test("ERR_DLOPEN_FAILED on the onnxruntime binding IS missing-runtime", () => {
        const err = Object.assign(
            new Error(
                "\\\\?\\C:\\...\\onnxruntime-node\\bin\\napi-v6\\win32\\x64\\onnxruntime_binding.node " +
                    "is not a valid Win32 application.",
            ),
            { code: "ERR_DLOPEN_FAILED" },
        );
        expect(isNativeRuntimeMissingError(err)).toBe(true);
    });

    test("MODULE_NOT_FOUND for the onnxruntime binding IS missing-runtime", () => {
        const err = Object.assign(
            new Error("Cannot find module '../bin/napi-v6/win32/x64/onnxruntime_binding.node'"),
            { code: "ERR_MODULE_NOT_FOUND" },
        );
        expect(isNativeRuntimeMissingError(err)).toBe(true);
    });

    test("ERR_DLOPEN_FAILED for an UNRELATED native module is not our runtime", () => {
        const err = Object.assign(new Error("some-other-native.node failed to load"), {
            code: "ERR_DLOPEN_FAILED",
        });
        expect(isNativeRuntimeMissingError(err)).toBe(false);
    });
});

// The provider passes configured `dtype` to the Transformers.js pipeline and includes it in the model identity.
// Changing `dtype` changes the identity, preventing mixed vector spaces.
// No configured dtype preserves the provider-and-model identity.
describe("LocalEmbeddingProvider dtype threading (#259)", () => {
    test("default constructor (no dtype) keeps the golden identity", () => {
        const provider = new LocalEmbeddingProvider();
        const expected = getEmbeddingProviderIdentity({
            provider: "local",
            model: "Xenova/bge-small-en-v1.5",
        });
        expect(provider.modelId).toBe(expected);
    });

    test("explicit fp32 dtype matches the default identity (fp32 is the default)", () => {
        const noDtype = new LocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 512);
        const fp32 = new LocalEmbeddingProvider(
            "Xenova/all-MiniLM-L6-v2",
            512,
            "fp32" as LocalEmbeddingDtype,
        );
        expect(fp32.modelId).toBe(noDtype.modelId);
    });

    test("a non-default dtype produces a different identity than the default", () => {
        const noDtype = new LocalEmbeddingProvider("Xenova/paraphrase-multilingual-MiniLM-L12-v2");
        const q8 = new LocalEmbeddingProvider(
            "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
            512,
            "q8" as LocalEmbeddingDtype,
        );
        expect(q8.modelId).not.toBe(noDtype.modelId);
        // The default local embedding identity equals the identity with `local_dtype` folded in.
        const expected = getEmbeddingProviderIdentity({
            provider: "local",
            model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
            local_dtype: "q8",
        });
        expect(q8.modelId).toBe(expected);
    });

    test("different non-default dtypes produce different identities", () => {
        const q8 = new LocalEmbeddingProvider(
            "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
            512,
            "q8" as LocalEmbeddingDtype,
        );
        const int8 = new LocalEmbeddingProvider(
            "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
            512,
            "int8" as LocalEmbeddingDtype,
        );
        expect(q8.modelId).not.toBe(int8.modelId);
    });
});

// A model's pooling and query instruction come from its own card.
// Applying another model's pooling or query instruction changes the produced vectors.
describe("local embedding recipes", () => {
    const BGE_MODEL = "Xenova/bge-small-en-v1.5";
    const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

    /** An identity without a recipe contains only the provider and model.
     * Unlisted models hash to the provider-and-model identity.
     * A recipe-bound model needs a distinct identity because its recipe changes the produced vectors.
     * */
    const preRecipeIdentity = (model: string): string =>
        `embedding-provider:${computeNormalizedHash(
            JSON.stringify({
                provider: "local",
                model,
                endpoint: "",
                apiKeyPresent: false,
            }),
        )}`;

    test("unlisted models keep the pre-recipe identity byte-identical", () => {
        const model = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
        expect(getEmbeddingProviderIdentity({ provider: "local", model })).toBe(
            preRecipeIdentity(model),
        );
    });

    test("a recipe-bound model folds its recipe into the identity", () => {
        expect(getEmbeddingProviderIdentity({ provider: "local", model: BGE_MODEL })).not.toBe(
            preRecipeIdentity(BGE_MODEL),
        );
    });

    test("bge-small binds CLS pooling and the query-only instruction", () => {
        expect(getLocalEmbeddingRecipe(BGE_MODEL)).toEqual({
            pooling: "cls",
            queryPrefix: BGE_QUERY_PREFIX,
        });
    });

    test("the default model has a bound recipe rather than the symmetric fallback", () => {
        expect(getLocalEmbeddingRecipe(DEFAULT_LOCAL_EMBEDDING_MODEL)).toEqual({
            pooling: "cls",
            queryPrefix: BGE_QUERY_PREFIX,
        });
    });

    test("the upstream BAAI id binds the same recipe as the Xenova export", () => {
        expect(getLocalEmbeddingRecipe("BAAI/bge-small-en-v1.5")).toEqual(
            getLocalEmbeddingRecipe(BGE_MODEL),
        );
    });

    test("unlisted models keep the symmetric mean recipe", () => {
        expect(getLocalEmbeddingRecipe("Xenova/all-MiniLM-L6-v2")).toEqual({
            pooling: "mean",
            queryPrefix: "",
        });
    });

    interface RecordedCall {
        input: string | string[];
        options: { pooling: "mean" | "cls"; normalize: true };
    }

    function providerWithRecordingPipeline(model: string): {
        provider: LocalEmbeddingProvider;
        calls: RecordedCall[];
    } {
        const calls: RecordedCall[] = [];
        const fake = (input: string | string[], options: RecordedCall["options"]) => {
            calls.push({ input, options });
            const count = Array.isArray(input) ? input.length : 1;
            return Promise.resolve({ data: new Float32Array(4 * count), dims: [count, 4] });
        };
        const provider = new LocalEmbeddingProvider(model);
        (provider as unknown as { pipeline: typeof fake }).pipeline = fake;
        return { provider, calls };
    }

    test("embed applies the query instruction for query purpose only", async () => {
        const { provider, calls } = providerWithRecordingPipeline(BGE_MODEL);
        await provider.embed("find the parser", undefined, "query");
        await provider.embed("the parser lives here", undefined, "passage");
        await provider.embed("no purpose given");
        expect(calls.map((c) => c.input)).toEqual([
            `${BGE_QUERY_PREFIX}find the parser`,
            "the parser lives here",
            "no purpose given",
        ]);
        expect(calls.every((c) => c.options.pooling === "cls")).toBe(true);
    });

    test("embedBatch prefixes every query text and leaves passages untouched", async () => {
        const { provider, calls } = providerWithRecordingPipeline(BGE_MODEL);
        await provider.embedBatch(["a", "b"], undefined, "query");
        await provider.embedBatch(["c", "d"], undefined, "passage");
        expect(calls[0]!.input).toEqual([`${BGE_QUERY_PREFIX}a`, `${BGE_QUERY_PREFIX}b`]);
        expect(calls[1]!.input).toEqual(["c", "d"]);
        expect(
            calls.every((c) => c.options.pooling === "cls" && c.options.normalize === true),
        ).toBe(true);
    });

    test("an unlisted model embeds queries unprefixed with mean pooling", async () => {
        const { provider, calls } = providerWithRecordingPipeline(
            "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
        );
        await provider.embed("find the parser", undefined, "query");
        expect(calls[0]!.input).toBe("find the parser");
        expect(calls[0]!.options.pooling).toBe("mean");
    });
});
