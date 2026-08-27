export interface GoldEvidenceBlock {
    label: string;
    content: string;
}

/** Render Arm R3 evidence as prompt text suitable for `harness.sendPrompt`. */
export function goldEvidencePrompt(
    blocks: readonly GoldEvidenceBlock[],
): string {
    return blocks
        .map(
            ({ label, content }) =>
                `<gold-evidence label="${label}">\n${content}\n</gold-evidence>`,
        )
        .join("\n\n");
}
