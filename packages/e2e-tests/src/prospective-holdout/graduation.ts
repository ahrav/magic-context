import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { scanForSensitiveContent } from "../../../plugin/scripts/retrieval-benchmark/privacy";
import {
    PROSPECTIVE_SOURCE_SCHEMA,
    parseProspectiveIncidentSource,
    type IncidentCatalog,
    type ProspectiveIncidentSource,
    type SourceInventory,
} from "../incident-pool/contract";
import { verifyProspectiveSourceEvidence } from "../incident-pool/evidence";
import { rowDigest } from "../incident-pool/history";
import {
    implementationBundleDigest,
    type IncidentCaseRegistry,
    validateRegistryCatalogCorrespondence,
} from "../incident-pool/registry";
import type { CohortCloseManifest } from "./contract";
import { HoldoutContractError, enumeration, exact, fail, hex64, record, staticId } from "./contract";
import type { PairedCaseFact } from "./comparison";
import type { ProspectiveReport } from "./report";

export interface GraduationCandidate {
    schema: "prospective-graduation-candidate/v1";
    sourceItemId: string;
    sourceClaimId: string;
    familyId: string;
    variantId: string;
    disposition: "executable-accepted-behavior" | "executable-regression";
    source: ProspectiveIncidentSource;
    sourceFingerprint: string;
    incidentBytes: unknown;
    implementationFingerprint: string;
}

/**
 * A case yields one pair per execution coordinate, so the disposition is a property of the whole
 * coordinate set rather than of any single cell: one passing model, seed, or platform says nothing
 * about the others. Accepted behavior therefore requires every coordinate to have completed with
 * both arms passing, and any incomplete or failing coordinate makes the case a regression.
 * `buildGraduationCandidate` and `validateGraduationPairBindings` read the disposition through this
 * one predicate so a stamped disposition cannot disagree with the validated one. Callers reject an
 * empty set first, because `every` over no coordinates is vacuously true.
 */
function dispositionFor(casePairs: readonly PairedCaseFact[]): GraduationCandidate["disposition"] {
    const allPass = casePairs.every((pair) =>
        pair.status === "complete" &&
        pair.releaseN.productOutcome === "pass" &&
        pair.releaseNMinus1.productOutcome === "pass"
    );
    return allPass ? "executable-accepted-behavior" : "executable-regression";
}

export function buildGraduationCandidate(input: {
    close: CohortCloseManifest;
    trustedCloseFingerprint: string;
    report: ProspectiveReport;
    pairs: readonly PairedCaseFact[];
    incidentBytes: unknown;
    semanticRevisionId: string;
    secondPrivacyApproval: { approver: string; subjectFingerprint: string };
    forbiddenTokens?: readonly string[];
    forbiddenIdentifiers?: readonly string[];
}): GraduationCandidate {
    const violations = scanForSensitiveContent({
        incidentBytes: input.incidentBytes,
        semanticRevisionId: input.semanticRevisionId,
        secondPrivacyApproval: input.secondPrivacyApproval,
    }, input);
    if (violations.length > 0) {
        throw new HoldoutContractError(
            violations.map((entry) => `graduation.privacy.${entry.category}:${entry.path}`),
        );
    }
    const [first] = input.pairs;
    if (!first) throw new HoldoutContractError(["graduation: pair-set-empty"]);
    // The set has to be exactly one case's coordinates, because the case identity it carries
    // selects the admitted case and every field the candidate copies out of it.
    if (input.pairs.some((pair) => pair.caseId !== first.caseId)) {
        throw new HoldoutContractError(["graduation: pair-set-multi-case"]);
    }
    // The candidate carries one implementation fingerprint for the whole set, so the coordinates
    // have to agree on it rather than the first one speaking for the rest.
    const implementationFingerprint = first.implementationFingerprint;
    if (input.pairs.some((pair) => pair.implementationFingerprint !== implementationFingerprint)) {
        throw new HoldoutContractError(["graduation: pair-set-implementation-drift"]);
    }
    const closed = input.close.body.cases.find((entry) => entry.caseId === first.caseId);
    if (!closed) throw new HoldoutContractError(["graduation: case-not-admitted"]);
    if (
        input.report.body.epochId !== input.close.body.epochId ||
        input.report.body.closeManifestFingerprint !== input.trustedCloseFingerprint ||
        input.pairs.some((pair) => pair.familyId !== closed.familyId)
    ) {
        throw new HoldoutContractError(["graduation: report-or-pair-binding-mismatch"]);
    }
    const incidentBytesFingerprint = canonicalFingerprint(input.incidentBytes);
    const approvalSubject = canonicalFingerprint({
        epochId: input.close.body.epochId,
        caseId: closed.caseId,
        closeManifestFingerprint: input.trustedCloseFingerprint,
        incidentBytesFingerprint,
    });
    if (input.secondPrivacyApproval.subjectFingerprint !== approvalSubject) {
        throw new HoldoutContractError(["graduation: second-privacy-approval-stale"]);
    }
    const source = parseProspectiveIncidentSource({
        schema: PROSPECTIVE_SOURCE_SCHEMA,
        epoch_id: input.close.body.epochId,
        case_id: closed.caseId,
        family_id: closed.familyId,
        close_manifest_fingerprint: input.trustedCloseFingerprint,
        case_commitment: closed.caseCommitment,
        semantic_revision_id: input.semanticRevisionId,
        incident_bytes_fingerprint: incidentBytesFingerprint,
        second_privacy_approval: {
            approver: input.secondPrivacyApproval.approver,
            subject_fingerprint: input.secondPrivacyApproval.subjectFingerprint,
        },
    });
    verifyProspectiveSourceEvidence(source, input.close, input.trustedCloseFingerprint, input.incidentBytes);
    const suffix = closed.caseId.slice("case-".length, "case-".length + 16);
    const sourceItemId = `src-prospective-${suffix}`;
    const sourceClaimId = `claim-prospective-${suffix}`;
    const variantId = `var-prospective-${suffix}`;
    const candidate: GraduationCandidate = {
        schema: "prospective-graduation-candidate/v1",
        sourceItemId,
        sourceClaimId,
        familyId: closed.familyId,
        variantId,
        disposition: dispositionFor(input.pairs),
        source,
        sourceFingerprint: rowDigest(source),
        incidentBytes: input.incidentBytes,
        implementationFingerprint,
    };
    const metadataViolations = scanForSensitiveContent(candidate, input);
    if (metadataViolations.length > 0) {
        throw new HoldoutContractError(
            metadataViolations.map((entry) => `graduation.privacy.${entry.category}:${entry.path}`),
        );
    }
    return candidate;
}

export function parseGraduationCandidate(raw: unknown): GraduationCandidate {
    const value = record(raw, "graduation");
    exact(value, [
        "schema", "sourceItemId", "sourceClaimId", "familyId", "variantId",
        "disposition", "source", "sourceFingerprint", "incidentBytes", "implementationFingerprint",
    ], "graduation");
    if (value.schema !== "prospective-graduation-candidate/v1") fail("graduation.schema: version-invalid");
    const source = parseProspectiveIncidentSource(value.source);
    const candidate: GraduationCandidate = {
        schema: "prospective-graduation-candidate/v1",
        sourceItemId: staticId(value.sourceItemId, "graduation.sourceItemId", /^src-[a-z0-9]+(?:-[a-z0-9]+)*$/),
        sourceClaimId: staticId(value.sourceClaimId, "graduation.sourceClaimId", /^claim-[a-z0-9]+(?:-[a-z0-9]+)*$/),
        familyId: staticId(value.familyId, "graduation.familyId", /^fam-[a-z0-9]+(?:-[a-z0-9]+)*$/),
        variantId: staticId(value.variantId, "graduation.variantId", /^var-[a-z0-9]+(?:-[a-z0-9]+)*$/),
        disposition: enumeration(value.disposition, ["executable-accepted-behavior", "executable-regression"] as const, "graduation.disposition"),
        source,
        sourceFingerprint: hex64(value.sourceFingerprint, "graduation.sourceFingerprint"),
        incidentBytes: value.incidentBytes,
        implementationFingerprint: hex64(value.implementationFingerprint, "graduation.implementationFingerprint"),
    };
    if (
        candidate.familyId !== source.family_id ||
        candidate.sourceFingerprint !== rowDigest(source) ||
        canonicalFingerprint(candidate.incidentBytes) !== source.incident_bytes_fingerprint
    ) {
        fail("graduation: source-binding-mismatch");
    }
    return candidate;
}

/**
 * Installs one candidate under its own name in the graduation directory.
 *
 * Every entry in that directory is a candidate: readers scan it and require each filename to
 * be `case-<32 hex>.json`, so a name staged there and left behind is read as a malformed
 * candidate rather than as work in progress. Staging therefore lives in the directory's parent,
 * the epoch root, under the `.staging-` prefix `mkdtempSync` completes — the same shape the
 * artifact publishers stage under there, which readers of an epoch root already recognise as
 * runtime state and skip. A publisher killed before its cleanup leaves that directory holding
 * the bytes it had written, beside the graduation directory instead of inside it, so the scan
 * still sees only candidates and the identical retry below republishes.
 *
 * `linkSync` is what installs the destination, and it fails rather than replacing an existing
 * name, so a retry lands on the byte comparison and an unequal candidate is reported instead of
 * overwriting the installed one.
 */
export function appendGraduationCandidate(candidate: GraduationCandidate, destination: string): void {
    const bytes = `${JSON.stringify(candidate, null, 2)}\n`;
    const directory = dirname(destination);
    mkdirSync(directory, { recursive: true });
    const staging = mkdtempSync(join(dirname(directory), ".staging-"));
    const staged = join(staging, basename(destination));
    try {
        writeFileSync(staged, bytes, { flag: "wx" });
        linkSync(staged, destination);
    } catch {
        if (!existsSync(destination) || readFileSync(destination, "utf8") !== bytes) {
            throw new HoldoutContractError(["graduation: append-conflict"]);
        }
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
}

export function validateGraduationPairBindings(
    candidates: readonly GraduationCandidate[],
    pairs: readonly PairedCaseFact[],
): void {
    for (const candidate of candidates) {
        // A case yields one pair per execution coordinate. Selecting a single pair would let a
        // regression in any other coordinate pass, so every pair for the case has to agree
        // with the candidate, and its disposition is derived from all of them together.
        const casePairs = pairs.filter((entry) => entry.caseId === candidate.source.case_id);
        if (
            casePairs.length === 0 ||
            casePairs.some((pair) =>
                pair.familyId !== candidate.familyId ||
                pair.implementationFingerprint !== candidate.implementationFingerprint
            ) ||
            candidate.disposition !== dispositionFor(casePairs)
        ) {
            throw new HoldoutContractError(["graduation: pair-binding-mismatch"]);
        }
    }
}

export function validateGraduationBindings(
    candidates: readonly GraduationCandidate[],
    pairs: readonly PairedCaseFact[],
    inventory: SourceInventory,
    catalog: IncidentCatalog,
    registry: IncidentCaseRegistry,
    repositoryRoot: string,
): void {
    validateGraduationPairBindings(candidates, pairs);
    validateRegistryCatalogCorrespondence(registry, catalog);
    for (const candidate of candidates) {
        const item = inventory.items.find((entry) => entry.id === candidate.sourceItemId);
        const claim = item?.claims.find((entry) => entry.id === candidate.sourceClaimId);
        const family = catalog.families.find((entry) => entry.id === candidate.familyId);
        const variant = family?.variants.find((entry) => entry.id === candidate.variantId);
        const registered = registry.get(candidate.variantId);
        if (
            !item || !claim || !family || !variant || !registered ||
            item.content_digest !== candidate.sourceFingerprint ||
            claim.content_digest !== candidate.sourceFingerprint ||
            !claim.family_links.includes(candidate.familyId) ||
            !family.source_claims.includes(candidate.sourceClaimId) ||
            !variant.source_claims.includes(candidate.sourceClaimId) ||
            variant.semantic_revision.id !== candidate.source.semantic_revision_id ||
            registered.fixtures.prospectiveSourceFingerprint !== candidate.sourceFingerprint ||
            implementationBundleDigest(repositoryRoot, registered.implementationFiles) !== candidate.implementationFingerprint
        ) {
            throw new HoldoutContractError(["graduation: incident-binding-mismatch"]);
        }
    }
}

export function validateGraduationCompleteness(
    close: CohortCloseManifest,
    candidates: readonly GraduationCandidate[],
): void {
    const expected = close.body.cases.map((entry) => entry.caseId).sort();
    const actual = candidates.map((entry) => entry.source.case_id).sort();
    if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new HoldoutContractError(["graduation: cohort-incomplete"]);
    }
}
