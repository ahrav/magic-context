// src/shared/resolve-fallbacks.ts
function resolveFallbackChain(userFallbacks) {
  const userList = normalizeUserFallbacks(userFallbacks);
  return dedupe(userList.filter(isValidModelSpec));
}
function normalizeUserFallbacks(userFallbacks) {
  if (!userFallbacks)
    return [];
  if (typeof userFallbacks === "string") {
    const trimmed = userFallbacks.trim();
    return trimmed ? [trimmed] : [];
  }
  return userFallbacks.map((s) => s.trim()).filter((s) => s.length > 0);
}
function isValidModelSpec(spec) {
  const slash = spec.indexOf("/");
  return slash > 0 && slash < spec.length - 1;
}
function dedupe(list) {
  const seen = new Set;
  const out = [];
  for (const item of list) {
    if (seen.has(item))
      continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}
function parseProviderModel(spec) {
  const slash = spec.indexOf("/");
  if (slash < 1 || slash >= spec.length - 1)
    return null;
  return {
    providerID: spec.slice(0, slash).trim(),
    modelID: spec.slice(slash + 1).trim()
  };
}
function modelBodyField(spec) {
  if (!spec)
    return {};
  const parsed = parseProviderModel(spec);
  return parsed ? { model: parsed } : {};
}

export { resolveFallbackChain, parseProviderModel, modelBodyField };
