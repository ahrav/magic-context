# Payload Decode Profile

Target: `payload_decode/decode/64` after iteration 33.

The benchmark-only `MC_SCOPE_PROFILE=payload-64` mode repeatedly decodes one payload with 64
affected paths and 64 config checks for ten seconds.

Evidence:

- 199 Hz: 1,993 samples, zero lost.
- serde_json string parsing and UTF-8 validation own about 31%.
- Serde's required internally tagged `CheckSpec` content visitors own about 28%.
- Allocator functions own about 11%; the remaining output strings and vectors are public owned
  values.

Decision: retain serde's generated decoder. A wire-shape change is incompatible, while a custom
order-independent tagged-enum decoder duplicates serde with a high correctness burden for one
microbenchmark. Batch-level repeated payload decoding is already removed by iteration 18.

Raw profile: `/tmp/mc-scope-perf/payload-64-iter33-199.data`; report:
`/tmp/mc-scope-perf/payload-64-iter33.report`.
