export interface GoldEvidenceBlock {
    label: string;
    content: string;
}

/* */
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
