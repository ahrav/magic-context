/**
 * Strict, versioned contracts for the incident regression pool (U1).
 *
 * Every parser is exact-key: unknown fields reject, enums are closed, and all
 * IDs/labels are static allowlisted-format strings so no dynamic fixture data
 * can ride a report or check label. Pattern follows
 * scripts/validate-mode-manifest.ts and the retrieval-benchmark contracts.
 */

export const SOURCE_INVENTORY_SCHEMA = "incident-source-inventory/v1";
export const INCIDENT_CATALOG_SCHEMA = "incident-catalog/v1";
export const ADJUDICATION_EVENT_SCHEMA = "incident-adjudication/v1";
export const EMERGENCY_REDACTION_SCHEMA = "incident-emergency-redaction/v1";

/** Closed source-claim disposition vocabulary (R2). */
export const SOURCE_DISPOSITIONS = [
    "executable_accepted_behavior",
    "executable_fixed_regression",
    "executable_known_defect",
    "informational",
    "verifier_evidence",
    "unsupported",
    "duplicate",
    "false_positive",
    "test_assumption",
    "unavailable",
    "historical_harness_gap",
] as const;
export type SourceDisposition = (typeof SOURCE_DISPOSITIONS)[number];

export const LANES = ["green", "known-red", "adjudication-only"] as const;
export type Lane = (typeof LANES)[number];
export const EXECUTABLE_LANES: readonly Lane[] = ["green", "known-red"];

export const HARNESSES = ["opencode", "pi", "rust"] as const;
export type Harness = (typeof HARNESSES)[number];

export const ADJUDICATION_KINDS = [
    "baseline",
    "correction",
    "resolution",
    "retirement",
] as const;
export type AdjudicationKind = (typeof ADJUDICATION_KINDS)[number];

export const BASELINE_VERDICTS = ["green", "red"] as const;
export type BaselineVerdict = (typeof BASELINE_VERDICTS)[number];

export const BINDING_STATUSES = ["declared", "live"] as const;
export type BindingStatus = (typeof BINDING_STATUSES)[number];

export const PROHIBITED_DATA_CLASSES = [
    "credential",
    "raw_prompt",
    "session_body",
    "memory_body",
    "process_output",
    "ambient_path",
    "other_sensitive",
] as const;
export type ProhibitedDataClass = (typeof PROHIBITED_DATA_CLASSES)[number];

export const REDACTION_SCOPES = [
    "source_item",
    "source_claim",
    "family",
    "variant",
    "adjudication_event",
] as const;
export type RedactionScope = (typeof REDACTION_SCOPES)[number];

/** Static ID formats. Lowercase kebab only — no interpolation, spaces, or
 *  template characters, so labels cannot carry fixture data. */
const idPattern = (prefix: string): RegExp =>
    new RegExp(`^${prefix}-[a-z0-9]+(?:-[a-z0-9]+)*$`);
export const SOURCE_ITEM_ID_RE = idPattern("src");
export const SOURCE_CLAIM_ID_RE = idPattern("claim");
export const FAMILY_ID_RE = idPattern("fam");
export const VARIANT_ID_RE = idPattern("var");
export const SEMANTIC_REVISION_ID_RE = idPattern("rev");
export const CHECK_ID_RE = idPattern("check");
export const EVIDENCE_REF_RE = idPattern("ev");
export const ADJUDICATION_EVENT_ID_RE = idPattern("adj");
export const REDACTION_EVENT_ID_RE = idPattern("red");
const HEX64_RE = /^[0-9a-f]{64}$/;

const IDENTITY_RES = [
    SOURCE_ITEM_ID_RE,
    SOURCE_CLAIM_ID_RE,
    FAMILY_ID_RE,
    VARIANT_ID_RE,
];

export interface SourceClaim {
    id: string;
    content_digest: string;
    disposition: SourceDisposition;
    rationale: string;
    family_links: string[];
}

export interface SourceItem {
    id: string;
    source_path: string;
    content_digest: string;
    claims: SourceClaim[];
}

export interface SourceInventory {
    schema: typeof SOURCE_INVENTORY_SCHEMA;
    items: SourceItem[];
}

export interface HarnessApplicability {
    harness: Harness;
    omitted: { harness: Harness; reason: string }[];
}

export interface VerifierBinding {
    driver: string;
    verifier: string;
    binding_status: BindingStatus;
    invalid_state_evidence: string[];
}

export interface SemanticRevision {
    id: string;
    fingerprint: string;
}

export interface IncidentVariant {
    id: string;
    lane: Lane;
    source_claims: string[];
    applicability: HarnessApplicability | null;
    semantic_revision: SemanticRevision;
    normative_checks: string[];
    verifier_binding: VerifierBinding | null;
    blocked_by: string[];
    evidence_refs: string[];
}

export interface IncidentFamily {
    id: string;
    title: string;
    source_claims: string[];
    variants: IncidentVariant[];
}

export interface IncidentCatalog {
    schema: typeof INCIDENT_CATALOG_SCHEMA;
    families: IncidentFamily[];
}

export interface AdjudicationEvent {
    schema: typeof ADJUDICATION_EVENT_SCHEMA;
    event_id: string;
    identity: string;
    seq: number;
    kind: AdjudicationKind;
    baseline_verdict: BaselineVerdict | null;
    semantic_fingerprint: string | null;
    expected_failed_checks: string[] | null;
    observation_signature: string | null;
    rationale: string;
    source_revision: string;
    supersedes: string | null;
}

export interface EmergencyRedactionEvent {
    schema: typeof EMERGENCY_REDACTION_SCHEMA;
    event_id: string;
    protected_base: string;
    scope: RedactionScope;
    target_id: string;
    old_digest: string;
    new_digest: string;
    prohibited_data_class: ProhibitedDataClass;
    preserves_logical_ids_and_order: true;
    review_reference: string;
}

function fail(label: string, message: string): never {
    throw new Error(`${label}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
    if (!isRecord(value)) fail(label, "must be an object");
    return value;
}

function requireExactKeys(
    record: Record<string, unknown>,
    keys: readonly string[],
    label: string,
): void {
    const actual = Object.keys(record).sort();
    const expected = [...keys].sort();
    if (
        actual.length !== expected.length ||
        actual.some((key, i) => key !== expected[i])
    ) {
        fail(
            label,
            `must contain exactly ${expected.join(", ")}; got ${actual.join(", ") || "no keys"}`,
        );
    }
}

function asNonEmptyString(value: unknown, label: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        fail(label, "must be a non-empty string");
    }
    return value;
}

function asId(value: unknown, re: RegExp, label: string): string {
    if (typeof value !== "string" || !re.test(value)) {
        fail(label, `must be a static lowercase id matching ${re.source}`);
    }
    return value;
}

function asHex64(value: unknown, label: string): string {
    if (typeof value !== "string" || !HEX64_RE.test(value)) {
        fail(label, "must be a lowercase sha-256 hex digest");
    }
    return value;
}

function asEnum<T extends string>(
    value: unknown,
    allowed: readonly T[],
    label: string,
): T {
    if (typeof value !== "string" || !allowed.includes(value as T)) {
        fail(label, `must be one of ${allowed.join(", ")}`);
    }
    return value as T;
}

function asArray(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) fail(label, "must be an array");
    return value;
}

function asUniqueIdArray(value: unknown, re: RegExp, label: string): string[] {
    const ids = asArray(value, label).map((entry, i) =>
        asId(entry, re, `${label}[${i}]`),
    );
    if (new Set(ids).size !== ids.length)
        fail(label, "must not contain duplicates");
    return ids;
}

/** Exact-key parse of the committed source inventory (R1, R2). */
export function parseSourceInventory(raw: unknown): SourceInventory {
    const root = asRecord(raw, "inventory");
    requireExactKeys(root, ["schema", "items"], "inventory");
    if (root.schema !== SOURCE_INVENTORY_SCHEMA) {
        fail("inventory.schema", `must be ${SOURCE_INVENTORY_SCHEMA}`);
    }
    const itemIds = new Set<string>();
    const claimIds = new Set<string>();
    const items = asArray(root.items, "inventory.items").map((rawItem, i) => {
        const label = `inventory.items[${i}]`;
        const item = asRecord(rawItem, label);
        requireExactKeys(
            item,
            ["id", "source_path", "content_digest", "claims"],
            label,
        );
        const id = asId(item.id, SOURCE_ITEM_ID_RE, `${label}.id`);
        if (itemIds.has(id)) fail(label, `duplicate source item id ${id}`);
        itemIds.add(id);
        const claims = asArray(item.claims, `${label}.claims`).map(
            (rawClaim, j) => {
                const claimLabel = `${label}.claims[${j}]`;
                const claim = asRecord(rawClaim, claimLabel);
                requireExactKeys(
                    claim,
                    [
                        "id",
                        "content_digest",
                        "disposition",
                        "rationale",
                        "family_links",
                    ],
                    claimLabel,
                );
                const claimId = asId(
                    claim.id,
                    SOURCE_CLAIM_ID_RE,
                    `${claimLabel}.id`,
                );
                if (claimIds.has(claimId))
                    fail(claimLabel, `duplicate source claim id ${claimId}`);
                claimIds.add(claimId);
                return {
                    id: claimId,
                    content_digest: asHex64(
                        claim.content_digest,
                        `${claimLabel}.content_digest`,
                    ),
                    disposition: asEnum(
                        claim.disposition,
                        SOURCE_DISPOSITIONS,
                        `${claimLabel}.disposition`,
                    ),
                    rationale: asNonEmptyString(
                        claim.rationale,
                        `${claimLabel}.rationale`,
                    ),
                    family_links: asUniqueIdArray(
                        claim.family_links,
                        FAMILY_ID_RE,
                        `${claimLabel}.family_links`,
                    ),
                } satisfies SourceClaim;
            },
        );
        return {
            id,
            source_path: asNonEmptyString(
                item.source_path,
                `${label}.source_path`,
            ),
            content_digest: asHex64(
                item.content_digest,
                `${label}.content_digest`,
            ),
            claims,
        } satisfies SourceItem;
    });
    return { schema: SOURCE_INVENTORY_SCHEMA, items };
}

function parseApplicability(raw: unknown, label: string): HarnessApplicability {
    const record = asRecord(raw, label);
    requireExactKeys(record, ["harness", "omitted"], label);
    const harness = asEnum(record.harness, HARNESSES, `${label}.harness`);
    const seen = new Set<Harness>();
    const omitted = asArray(record.omitted, `${label}.omitted`).map(
        (rawOmit, i) => {
            const omitLabel = `${label}.omitted[${i}]`;
            const omit = asRecord(rawOmit, omitLabel);
            requireExactKeys(omit, ["harness", "reason"], omitLabel);
            const omittedHarness = asEnum(
                omit.harness,
                HARNESSES,
                `${omitLabel}.harness`,
            );
            if (omittedHarness === harness)
                fail(omitLabel, "cannot omit the declared canonical harness");
            if (seen.has(omittedHarness))
                fail(omitLabel, `duplicate omitted harness ${omittedHarness}`);
            seen.add(omittedHarness);
            return {
                harness: omittedHarness,
                reason: asNonEmptyString(omit.reason, `${omitLabel}.reason`),
            };
        },
    );
    return { harness, omitted };
}

function parseVerifierBinding(raw: unknown, label: string): VerifierBinding {
    const record = asRecord(raw, label);
    requireExactKeys(
        record,
        ["driver", "verifier", "binding_status", "invalid_state_evidence"],
        label,
    );
    const evidence = asArray(
        record.invalid_state_evidence,
        `${label}.invalid_state_evidence`,
    ).map((entry, i) =>
        asNonEmptyString(entry, `${label}.invalid_state_evidence[${i}]`),
    );
    if (evidence.length === 0)
        fail(
            `${label}.invalid_state_evidence`,
            "must name at least one crafted invalid state",
        );
    if (new Set(evidence).size !== evidence.length) {
        fail(`${label}.invalid_state_evidence`, "must not contain duplicates");
    }
    return {
        driver: asNonEmptyString(record.driver, `${label}.driver`),
        verifier: asNonEmptyString(record.verifier, `${label}.verifier`),
        binding_status: asEnum(
            record.binding_status,
            BINDING_STATUSES,
            `${label}.binding_status`,
        ),
        invalid_state_evidence: evidence,
    };
}

function parseVariant(raw: unknown, label: string): IncidentVariant {
    const record = asRecord(raw, label);
    requireExactKeys(
        record,
        [
            "id",
            "lane",
            "source_claims",
            "applicability",
            "semantic_revision",
            "normative_checks",
            "verifier_binding",
            "blocked_by",
            "evidence_refs",
        ],
        label,
    );
    const id = asId(record.id, VARIANT_ID_RE, `${label}.id`);
    const lane = asEnum(record.lane, LANES, `${label}.lane`);
    const sourceClaims = asUniqueIdArray(
        record.source_claims,
        SOURCE_CLAIM_ID_RE,
        `${label}.source_claims`,
    );
    if (sourceClaims.length === 0)
        fail(
            `${label}.source_claims`,
            "must reference at least one source claim",
        );

    const revisionLabel = `${label}.semantic_revision`;
    const revision = asRecord(record.semantic_revision, revisionLabel);
    requireExactKeys(revision, ["id", "fingerprint"], revisionLabel);
    const semanticRevision: SemanticRevision = {
        id: asId(revision.id, SEMANTIC_REVISION_ID_RE, `${revisionLabel}.id`),
        fingerprint: asHex64(
            revision.fingerprint,
            `${revisionLabel}.fingerprint`,
        ),
    };

    const normativeChecks = asUniqueIdArray(
        record.normative_checks,
        CHECK_ID_RE,
        `${label}.normative_checks`,
    );
    const blockedBy = asUniqueIdArray(
        record.blocked_by,
        VARIANT_ID_RE,
        `${label}.blocked_by`,
    );
    if (blockedBy.includes(id))
        fail(`${label}.blocked_by`, "cannot depend on itself");
    const evidenceRefs = asUniqueIdArray(
        record.evidence_refs,
        EVIDENCE_REF_RE,
        `${label}.evidence_refs`,
    );

    const executable = EXECUTABLE_LANES.includes(lane);
    let applicability: HarnessApplicability | null = null;
    if (record.applicability !== null) {
        applicability = parseApplicability(
            record.applicability,
            `${label}.applicability`,
        );
    }
    let verifierBinding: VerifierBinding | null = null;
    if (record.verifier_binding !== null) {
        verifierBinding = parseVerifierBinding(
            record.verifier_binding,
            `${label}.verifier_binding`,
        );
    }

    if (executable) {
        if (applicability === null)
            fail(label, `${lane} lane requires harness applicability`);
        if (verifierBinding === null)
            fail(label, `${lane} lane requires a verifier binding`);
        if (normativeChecks.length === 0)
            fail(label, `${lane} lane requires at least one normative check`);
    } else {
        if (applicability !== null)
            fail(
                label,
                "adjudication-only lane must not declare harness applicability",
            );
        if (verifierBinding !== null)
            fail(
                label,
                "adjudication-only lane must not carry a driver or verifier binding",
            );
        if (normativeChecks.length !== 0)
            fail(
                label,
                "adjudication-only lane must not declare normative checks",
            );
        if (blockedBy.length !== 0)
            fail(
                label,
                "adjudication-only lane must not declare blocked dependencies",
            );
    }

    return {
        id,
        lane,
        source_claims: sourceClaims,
        applicability,
        semantic_revision: semanticRevision,
        normative_checks: normativeChecks,
        verifier_binding: verifierBinding,
        blocked_by: blockedBy,
        evidence_refs: evidenceRefs,
    };
}

/** Exact-key parse of the committed incident catalog (R3, R4). */
export function parseIncidentCatalog(raw: unknown): IncidentCatalog {
    const root = asRecord(raw, "catalog");
    requireExactKeys(root, ["schema", "families"], "catalog");
    if (root.schema !== INCIDENT_CATALOG_SCHEMA) {
        fail("catalog.schema", `must be ${INCIDENT_CATALOG_SCHEMA}`);
    }
    const familyIds = new Set<string>();
    const variantIds = new Set<string>();
    const families = asArray(root.families, "catalog.families").map(
        (rawFamily, i) => {
            const label = `catalog.families[${i}]`;
            const family = asRecord(rawFamily, label);
            requireExactKeys(
                family,
                ["id", "title", "source_claims", "variants"],
                label,
            );
            const id = asId(family.id, FAMILY_ID_RE, `${label}.id`);
            if (familyIds.has(id)) fail(label, `duplicate family id ${id}`);
            familyIds.add(id);
            const sourceClaims = asUniqueIdArray(
                family.source_claims,
                SOURCE_CLAIM_ID_RE,
                `${label}.source_claims`,
            );
            if (sourceClaims.length === 0)
                fail(
                    `${label}.source_claims`,
                    "must reference at least one source claim",
                );
            const variants = asArray(family.variants, `${label}.variants`).map(
                (rawVariant, j) => {
                    const variant = parseVariant(
                        rawVariant,
                        `${label}.variants[${j}]`,
                    );
                    if (variantIds.has(variant.id))
                        fail(
                            `${label}.variants[${j}]`,
                            `duplicate variant id ${variant.id}`,
                        );
                    variantIds.add(variant.id);
                    return variant;
                },
            );
            if (variants.length === 0)
                fail(`${label}.variants`, "must contain at least one variant");
            return {
                id,
                title: asNonEmptyString(family.title, `${label}.title`),
                source_claims: sourceClaims,
                variants,
            };
        },
    );
    for (const family of families) {
        for (const variant of family.variants) {
            for (const dependency of variant.blocked_by) {
                if (!variantIds.has(dependency)) {
                    fail(
                        `catalog variant ${variant.id}`,
                        `blocked_by references unknown variant ${dependency}`,
                    );
                }
            }
        }
    }
    rejectBlockedByCycles(families);
    return { schema: INCIDENT_CATALOG_SCHEMA, families };
}

/**
 * blocked_by is a scheduling dependency, so a cycle would deadlock the
 * scheduler with every member permanently waiting on another. Existence
 * checks above cannot see one; reject it at parse time instead.
 */
function rejectBlockedByCycles(families: IncidentCatalog["families"]): void {
    const dependents = new Map<string, string[]>();
    for (const family of families) {
        for (const variant of family.variants) {
            dependents.set(variant.id, [...variant.blocked_by]);
        }
    }
    // Iterative depth-first search with a node-state mark (1 = on stack,
    // 2 = fully explored); any back edge to an on-stack node is a cycle.
    const state = new Map<string, 0 | 1 | 2>();
    for (const start of dependents.keys()) {
        if (state.get(start)) continue;
        const path: string[] = [start];
        const iterators: Array<Iterator<string>> = [
            (dependents.get(start) ?? [])[Symbol.iterator](),
        ];
        state.set(start, 1);
        while (path.length > 0) {
            const next = iterators[iterators.length - 1]!.next();
            if (next.done) {
                state.set(path.pop()!, 2);
                iterators.pop();
                continue;
            }
            const dependency = next.value;
            const mark = state.get(dependency);
            if (mark === 1) {
                fail(
                    "catalog variants",
                    `blocked_by dependency cycle: ${[...path.slice(path.indexOf(dependency)), dependency].join(" -> ")}`,
                );
            }
            if (mark) continue;
            state.set(dependency, 1);
            path.push(dependency);
            iterators.push((dependents.get(dependency) ?? [])[Symbol.iterator]());
        }
    }
}

/** Exact-key parse of one adjudication ledger event. */
export function parseAdjudicationEvent(
    raw: unknown,
    label: string,
): AdjudicationEvent {
    const record = asRecord(raw, label);
    requireExactKeys(
        record,
        [
            "schema",
            "event_id",
            "identity",
            "seq",
            "kind",
            "baseline_verdict",
            "semantic_fingerprint",
            "expected_failed_checks",
            "observation_signature",
            "rationale",
            "source_revision",
            "supersedes",
        ],
        label,
    );
    if (record.schema !== ADJUDICATION_EVENT_SCHEMA)
        fail(`${label}.schema`, `must be ${ADJUDICATION_EVENT_SCHEMA}`);
    const eventId = asId(
        record.event_id,
        ADJUDICATION_EVENT_ID_RE,
        `${label}.event_id`,
    );
    const identity = record.identity;
    if (
        typeof identity !== "string" ||
        !IDENTITY_RES.some((re) => re.test(identity))
    ) {
        fail(
            `${label}.identity`,
            "must be a source item, source claim, family, or variant id",
        );
    }
    const seq = record.seq;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
        fail(`${label}.seq`, "must be a positive integer");
    }
    const kind = asEnum(record.kind, ADJUDICATION_KINDS, `${label}.kind`);
    const supersedes =
        record.supersedes === null
            ? null
            : asId(
                  record.supersedes,
                  ADJUDICATION_EVENT_ID_RE,
                  `${label}.supersedes`,
              );

    let baselineVerdict: BaselineVerdict | null = null;
    let semanticFingerprint: string | null = null;
    let expectedFailedChecks: string[] | null = null;
    let observationSignature: string | null = null;
    if (kind === "baseline") {
        baselineVerdict = asEnum(
            record.baseline_verdict,
            BASELINE_VERDICTS,
            `${label}.baseline_verdict`,
        );
        semanticFingerprint = asHex64(
            record.semantic_fingerprint,
            `${label}.semantic_fingerprint`,
        );
        if (baselineVerdict === "red") {
            expectedFailedChecks = asUniqueIdArray(
                record.expected_failed_checks,
                CHECK_ID_RE,
                `${label}.expected_failed_checks`,
            );
            if (expectedFailedChecks.length === 0) {
                fail(
                    `${label}.expected_failed_checks`,
                    "red baseline requires at least one expected failed check",
                );
            }
            observationSignature = asHex64(
                record.observation_signature,
                `${label}.observation_signature`,
            );
        } else if (
            record.expected_failed_checks !== null ||
            record.observation_signature !== null
        ) {
            fail(
                label,
                "green baseline must not carry expected failed checks or an observation signature",
            );
        }
    } else if (
        record.baseline_verdict !== null ||
        record.semantic_fingerprint !== null ||
        record.expected_failed_checks !== null ||
        record.observation_signature !== null
    ) {
        fail(
            label,
            `${kind} event must not carry baseline verdict, fingerprint, or signature fields`,
        );
    }

    return {
        schema: ADJUDICATION_EVENT_SCHEMA,
        event_id: eventId,
        identity,
        seq,
        kind,
        baseline_verdict: baselineVerdict,
        semantic_fingerprint: semanticFingerprint,
        expected_failed_checks: expectedFailedChecks,
        observation_signature: observationSignature,
        rationale: asNonEmptyString(record.rationale, `${label}.rationale`),
        source_revision: asNonEmptyString(
            record.source_revision,
            `${label}.source_revision`,
        ),
        supersedes,
    };
}

/** Exact-key parse of one emergency-redaction event — the only authorized
 *  destructive-history input (KTD1). */
export function parseEmergencyRedaction(
    raw: unknown,
    label: string,
): EmergencyRedactionEvent {
    const record = asRecord(raw, label);
    requireExactKeys(
        record,
        [
            "schema",
            "event_id",
            "protected_base",
            "scope",
            "target_id",
            "old_digest",
            "new_digest",
            "prohibited_data_class",
            "preserves_logical_ids_and_order",
            "review_reference",
        ],
        label,
    );
    if (record.schema !== EMERGENCY_REDACTION_SCHEMA)
        fail(`${label}.schema`, `must be ${EMERGENCY_REDACTION_SCHEMA}`);
    const oldDigest = asHex64(record.old_digest, `${label}.old_digest`);
    const newDigest = asHex64(record.new_digest, `${label}.new_digest`);
    if (oldDigest === newDigest) fail(label, "old and new digests must differ");
    if (record.preserves_logical_ids_and_order !== true) {
        fail(
            `${label}.preserves_logical_ids_and_order`,
            "must be exactly true",
        );
    }
    return {
        schema: EMERGENCY_REDACTION_SCHEMA,
        event_id: asId(
            record.event_id,
            REDACTION_EVENT_ID_RE,
            `${label}.event_id`,
        ),
        protected_base: asNonEmptyString(
            record.protected_base,
            `${label}.protected_base`,
        ),
        scope: asEnum(record.scope, REDACTION_SCOPES, `${label}.scope`),
        target_id: asNonEmptyString(record.target_id, `${label}.target_id`),
        old_digest: oldDigest,
        new_digest: newDigest,
        prohibited_data_class: asEnum(
            record.prohibited_data_class,
            PROHIBITED_DATA_CLASSES,
            `${label}.prohibited_data_class`,
        ),
        preserves_logical_ids_and_order: true,
        review_reference: asNonEmptyString(
            record.review_reference,
            `${label}.review_reference`,
        ),
    };
}
