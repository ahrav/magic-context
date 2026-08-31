#!/usr/bin/env python3
"""Generates the committed synapse-tiny test bundle (run inside synapse-tiny/).

Deterministic: every artifact byte, hash, fingerprint, and expected vector
is reproducible from this script. The model is a toy embedding table lookup
(Gather) with two outputs so output selection is observable:

  last_hidden_state = table[input_ids]            (the certified output)
  token_embeddings  = last_hidden_state + offset  (a wrong, dimension-
                                                   compatible decoy)

Mean pooling over the attention mask plus FastEmbed's fixed L2 normalization
produces the expected corpus vectors. NOT A PRODUCTION MODEL.
"""

import hashlib
import json
import re

import numpy as np
import onnx
from onnx import TensorProto, helper

DIMS = 8
MAX_TOKENS = 8
WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"]
VOCAB = {"[PAD]": 0, "[UNK]": 1, **{w: i + 2 for i, w in enumerate(WORDS)}}
VOCAB_SIZE = len(VOCAB)

rng = np.random.default_rng(20260820)
TABLE = rng.standard_normal((VOCAB_SIZE, DIMS)).astype(np.float32)
OFFSET = np.linspace(0.5, 4.0, DIMS).astype(np.float32)


def build_model() -> onnx.ModelProto:
    table_bytes = TABLE.tobytes()
    with open("embedding.bin", "wb") as f:
        f.write(table_bytes)
    table = TensorProto()
    table.name = "table"
    table.data_type = TensorProto.FLOAT
    table.dims.extend([VOCAB_SIZE, DIMS])
    table.data_location = TensorProto.EXTERNAL
    entry = table.external_data.add()
    entry.key = "location"
    entry.value = "embedding.bin"
    entry = table.external_data.add()
    entry.key = "offset"
    entry.value = "0"
    entry = table.external_data.add()
    entry.key = "length"
    entry.value = str(len(table_bytes))

    offset = helper.make_tensor("offset", TensorProto.FLOAT, [DIMS], OFFSET.tolist())

    input_ids = helper.make_tensor_value_info("input_ids", TensorProto.INT64, ["batch", "seq"])
    attention_mask = helper.make_tensor_value_info(
        "attention_mask", TensorProto.INT64, ["batch", "seq"]
    )
    last_hidden = helper.make_tensor_value_info(
        "last_hidden_state", TensorProto.FLOAT, ["batch", "seq", DIMS]
    )
    token_embeds = helper.make_tensor_value_info(
        "token_embeddings", TensorProto.FLOAT, ["batch", "seq", DIMS]
    )

    gather = helper.make_node("Gather", ["table", "input_ids"], ["last_hidden_state"], axis=0)
    add = helper.make_node("Add", ["last_hidden_state", "offset"], ["token_embeddings"])

    graph = helper.make_graph(
        [gather, add],
        "synapse_tiny",
        [input_ids, attention_mask],
        [last_hidden, token_embeds],
        initializer=[table, offset],
    )
    model = helper.make_model(
        graph,
        opset_imports=[helper.make_opsetid("", 13)],
        producer_name="synapse-tiny-generator",
    )
    model.ir_version = 8
    onnx.checker.check_model(model)
    return model


def tokenize(text: str) -> list[int]:
    tokens = re.findall(r"\w+|[^\w\s]+", text)
    return [VOCAB.get(t, VOCAB["[UNK]"]) for t in tokens][:MAX_TOKENS]


def expected_vector(text: str, pooling: str = "mean", output: str = "last_hidden_state"):
    ids = tokenize(text)
    if not ids:
        raise ValueError("corpus texts must tokenize to at least one token")
    hidden = TABLE[ids]
    if output == "token_embeddings":
        hidden = hidden + OFFSET
    pooled = hidden.mean(axis=0) if pooling == "mean" else hidden[0]
    norm = float(np.sqrt((pooled * pooled).sum()))
    return (pooled / (norm + 1e-12)).tolist()


def sha256_file(name: str) -> str:
    with open(name, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def write_json(name: str, value) -> None:
    with open(name, "w") as f:
        json.dump(value, f, indent=1, sort_keys=True)
        f.write("\n")


def canonical_fingerprint(
    artifacts, *, pooling, quantization, output, max_tokens, dims, table_epoch
) -> str:
    """The lane fingerprint the host recomputes and enforces.

    Mirrors `canonical_fingerprint` in crates/mc-host/src/synapse/bundle.rs,
    which is the source of truth: SHA-256 over a versioned, newline-joined
    `key=value` serialization of exactly the fields that determine the
    embedding space. A change there must land here in the same edit, or the
    host rejects every bundle this generator writes.
    """
    if output.get("name") is not None:
        selector = f"name:{output['name']}"
    elif output.get("index") is not None:
        selector = f"index:{output['index']}"
    elif output.get("only_one") is True:
        selector = "only_one"
    else:
        raise ValueError("output selects no tensor")
    tokenizer = artifacts["tokenizer"]
    lines = [
        "mc-synapse-fingerprint-v2",
        f"model_file={artifacts['model_file']['sha256']}",
    ]
    lines += [
        f"external_initializer={len(a['name'].encode())}:{a['name']}:{a['sha256']}"
        for a in artifacts["external_initializers"]
    ]
    lines += [
        f"tokenizer={tokenizer['tokenizer']['sha256']}",
        f"config={tokenizer['config']['sha256']}",
        f"special_tokens_map={tokenizer['special_tokens_map']['sha256']}",
        f"tokenizer_config={tokenizer['tokenizer_config']['sha256']}",
        f"pooling={pooling}",
        f"quantization={quantization}",
        f"output={selector}",
        f"max_tokens={max_tokens}",
        f"dims={dims}",
        f"table_epoch={table_epoch}",
        f"corpus={artifacts['corpus']['sha256']}",
    ]
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()


def main() -> None:
    model = build_model()
    with open("model.onnx", "wb") as f:
        f.write(model.SerializeToString())

    write_json(
        "tokenizer.json",
        {
            "version": "1.0",
            "truncation": None,
            "padding": None,
            "added_tokens": [],
            "normalizer": None,
            "pre_tokenizer": {"type": "Whitespace"},
            "post_processor": None,
            "decoder": None,
            "model": {"type": "WordLevel", "vocab": VOCAB, "unk_token": "[UNK]"},
        },
    )
    write_json("config.json", {"pad_token_id": 0})
    write_json(
        "special_tokens_map.json",
        {"pad_token": "[PAD]", "unk_token": "[UNK]"},
    )
    write_json(
        "tokenizer_config.json",
        {"model_max_length": MAX_TOKENS, "pad_token": "[PAD]"},
    )

    corpus_texts = [
        "alpha beta gamma",
        "kappa iota theta eta",
        "alpha",
        "alpha beta gamma delta epsilon zeta eta theta",
        "alpha beta gamma delta epsilon zeta eta theta iota kappa",
        "unknownword alpha",
    ]
    corpus = {
        "tolerance": 1e-4,
        "items": [{"text": t, "expected": expected_vector(t)} for t in corpus_texts],
    }
    write_json("corpus.json", corpus)

    artifacts = {
        "model_file": {"name": "model.onnx", "sha256": sha256_file("model.onnx")},
        "external_initializers": [
            {"name": "embedding.bin", "sha256": sha256_file("embedding.bin")}
        ],
        "tokenizer": {
            "tokenizer": {"name": "tokenizer.json", "sha256": sha256_file("tokenizer.json")},
            "config": {"name": "config.json", "sha256": sha256_file("config.json")},
            "special_tokens_map": {
                "name": "special_tokens_map.json",
                "sha256": sha256_file("special_tokens_map.json"),
            },
            "tokenizer_config": {
                "name": "tokenizer_config.json",
                "sha256": sha256_file("tokenizer_config.json"),
            },
        },
        "corpus": {"name": "corpus.json", "sha256": sha256_file("corpus.json")},
    }

    manifest = {
        "schema_version": 1,
        "model": "tiny-test-model",
        "table_epoch": 1,
        "dims": DIMS,
        "pooling": "mean",
        "quantization": "none",
        "output": {"name": "last_hidden_state"},
        "max_tokens": MAX_TOKENS,
        "provenance": {"source": "synapse-tiny test generator", "production": False},
        "recommended_batch": {"rows": 16, "token_budget": 8192},
        **artifacts,
    }
    fingerprint = canonical_fingerprint(
        artifacts,
        pooling=manifest["pooling"],
        quantization=manifest["quantization"],
        output=manifest["output"],
        max_tokens=manifest["max_tokens"],
        dims=manifest["dims"],
        table_epoch=manifest["table_epoch"],
    )
    manifest["fingerprint"] = fingerprint
    write_json("manifest.json", manifest)
    print("fingerprint:", fingerprint)


if __name__ == "__main__":
    main()
