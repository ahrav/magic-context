// src/shared/harness-provider-map.ts
var CANONICAL_TO_PI_PROVIDER = {
  openai: "openai-codex",
  google: "google-antigravity"
};
var PI_TO_CANONICAL_PROVIDER = {
  "openai-codex": "openai",
  "google-antigravity": "google"
};
var CANONICAL_TO_OMP_PROVIDER = {
  openai: "openai-codex",
  google: "google-antigravity"
};
var OMP_TO_CANONICAL_PROVIDER = {
  "openai-codex": "openai",
  "google-antigravity": "google"
};
function remapProviderPrefix(ref, map) {
  if (typeof ref !== "string")
    return ref;
  const slash = ref.indexOf("/");
  if (slash <= 0)
    return ref;
  const provider = ref.slice(0, slash);
  if (!Object.hasOwn(map, provider))
    return ref;
  return `${map[provider]}${ref.slice(slash)}`;
}
function piModelRefToCanonical(ref) {
  return remapProviderPrefix(ref, PI_TO_CANONICAL_PROVIDER);
}
function resolveModelRefForPi(ref) {
  return remapProviderPrefix(piModelRefToCanonical(ref), CANONICAL_TO_PI_PROVIDER);
}
function modelRefLookupOrder(ref) {
  const canonical = piModelRefToCanonical(ompModelRefToCanonical(ref));
  return [
    ...new Set([
      canonical,
      ref,
      resolveModelRefForPi(canonical),
      resolveModelRefForOmp(canonical)
    ])
  ];
}
function ompModelRefToCanonical(ref) {
  return remapProviderPrefix(ref, OMP_TO_CANONICAL_PROVIDER);
}
function resolveModelRefForOmp(ref) {
  return remapProviderPrefix(ompModelRefToCanonical(ref), CANONICAL_TO_OMP_PROVIDER);
}

export { piModelRefToCanonical, modelRefLookupOrder };
