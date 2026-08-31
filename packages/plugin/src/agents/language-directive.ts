interface ContentLanguageDirectiveOptions {
    preserveUserQuotes?: boolean;
    retrospective?: boolean;
}

const ENGLISH_LANGUAGE_NAMES = new Intl.DisplayNames(["en"], {
    type: "language",
    fallback: "none",
});

/**
 * resolveLanguageName returns the English language name and endonym when they differ.
 * "tr" resolves to "Turkish (Türkçe)"; "es" resolves to "Spanish (Español)".
 */
export function resolveLanguageName(language?: string): string {
    const code = typeof language === "string" ? language.trim().toLowerCase() : "";
    if (!/^[a-z]{2}$/.test(code)) return "";
    let english: string | undefined;
    try {
        english = ENGLISH_LANGUAGE_NAMES.of(code) ?? undefined;
    } catch {
        return "";
    }
    if (!english) return "";
    let endonym: string | undefined;
    try {
        endonym =
            new Intl.DisplayNames([code], { type: "language", fallback: "none" }).of(code) ??
            undefined;
    } catch {
        endonym = undefined;
    }
    return endonym && endonym !== english ? `${english} (${endonym})` : english;
}

/* */
export function isValidLanguageCode(language?: string): boolean {
    return resolveLanguageName(language) !== "";
}

/* */
export function buildContentLanguageDirective(
    language?: string,
    options: ContentLanguageDirectiveOptions = {},
): string {
    const target = resolveLanguageName(language);
    if (!target) return "";

    const lines = [
        "## Output language",
        "",
        `Write human-readable prose you author in: ${target}.`,
        "",
        "Do not translate or rename structural tokens. Copy required output schemas exactly:",
        "- XML tag names, XML attribute names, JSON keys, tool names, tool-call argument keys, enum values, booleans/null, and required sentinel strings stay in English exactly as shown.",
        "- Keep code identifiers, file paths, commands, config keys, CLI flags, URLs, commit hashes, model/provider IDs, stack traces, diagnostics, and transcript role markers such as U:, A:, and TC: verbatim.",
        "- Localize only free-text prose values/content: summaries, memory text, explanations, titles, observations, and answers — unless the prompt says to preserve original wording.",
        "",
        "These literal values must remain English when used:",
        "PROJECT_RULES, ARCHITECTURE, CONSTRAINTS, CONFIG_VALUES, NAMING;",
        "causal_incident, trajectory_correction;",
        "feature, design, docs, release, investigation, bug, refactor, infra;",
        "memory, observation; true, false; No relevant memories found.",
        "",
        "Preserve the required output shape. Do not add commentary outside the requested XML/JSON/tool output.",
    ];

    if (options.preserveUserQuotes) {
        lines.push(
            "",
            `Preserve U: lines and directly quoted user text in their original source language; write the surrounding summary prose in ${target}.`,
        );
    }
    if (options.retrospective) {
        lines.push(
            "",
            `Write the lesson text in ${target}; paraphrase source text and never quote the user.`,
        );
    }

    return lines.join("\n");
}

/* */
export function withContentLanguageDirective(
    systemPrompt: string,
    language?: string,
    options: ContentLanguageDirectiveOptions = {},
): string {
    const directive = buildContentLanguageDirective(language, options);
    return directive ? `${systemPrompt}\n\n${directive}` : systemPrompt;
}

/* */
export function buildMigrationLanguageDirective(language?: string): string {
    const target = resolveLanguageName(language);
    if (!target) return "";
    return [
        "## Output language",
        "",
        "Preserve each migrated memory's existing language — do NOT translate a memory just because an output language is set. When merging memories written in different languages, use the language of the clearest / source-majority memory; otherwise keep the source phrasing. Only the category re-mapping changes.",
    ].join("\n");
}

/* */
export function withMigrationLanguageDirective(systemPrompt: string, language?: string): string {
    const directive = buildMigrationLanguageDirective(language);
    return directive ? `${systemPrompt}\n\n${directive}` : systemPrompt;
}

/* */
export function buildPrimaryLanguageDirective(language?: string): string {
    const target = resolveLanguageName(language);
    if (!target) return "";
    return `Use ${target} for your natural-language replies to the user unless the user explicitly asks for another language. Keep code, identifiers, file paths, commands, logs, and quoted text verbatim.`;
}
