interface ContentLanguageDirectiveOptions {
    preserveUserQuotes?: boolean;
    retrospective?: boolean;
}
/**
 * Resolve a 2-letter ISO 639-1 code to the model-facing name string we validated
 * against weak models: "English (Endonym)", e.g. "tr" -> "Turkish (Türkçe)",
 * "es" -> "Spanish (Español)". A name (not a bare code) is what makes a weak
 * model reliably write in-language. Built from Intl.DisplayNames, so there is no
 * hardcoded language table to maintain. Returns "" for anything that is not a
 * resolvable 2-letter code, so an unset OR invalid value emits no directive.
 */
export declare function resolveLanguageName(language?: string): string;
/** True when `language` is a resolvable 2-letter ISO 639-1 code. */
export declare function isValidLanguageCode(language?: string): boolean;
/** Build guidance for hidden agents that author prose. Returns "" when unset. */
export declare function buildContentLanguageDirective(language?: string, options?: ContentLanguageDirectiveOptions): string;
/** Append content-language guidance to a hidden-agent system prompt. */
export declare function withContentLanguageDirective(systemPrompt: string, language?: string, options?: ContentLanguageDirectiveOptions): string;
/** Build migration-specific guidance. Returns "" when unset. */
export declare function buildMigrationLanguageDirective(language?: string): string;
/** Append migration-specific language guidance to a system prompt. */
export declare function withMigrationLanguageDirective(systemPrompt: string, language?: string): string;
/** Build the primary-agent reply directive. Returns "" when unset. */
export declare function buildPrimaryLanguageDirective(language?: string): string;
export {};
//# sourceMappingURL=language-directive.d.ts.map