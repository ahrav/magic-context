import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DiagnosticReport, renderDiagnosticsMarkdown } from "./diagnostics-opencode";
import { capBodyToGithubLimit, extractRecentErrors } from "./issue-body";
import { sanitizeConfigValue, sanitizeDiagnosticText } from "./redaction";

/**
 *
 *      twice.
 */
export function sanitizeLogContent(content: string): string {
    return sanitizeDiagnosticText(content);
}

function formatTimestamp(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    return [
        String(date.getFullYear()),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        "-",
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
    ].join("");
}

export interface BundledIssueReport {
    path: string;
    bodyMarkdown: string;
}

/**
 */
const HISTORIAN_LOG_PATTERNS = [
    /historian failure:/,
    /historian failure recorded:/,
    /historian prompt failed:/,
    /## Historian alert/,
    /historian alert suppressed/,
    /EMERGENCY: aborting session/,
    /historian: prompt attempt \d+ failed:/,
];

function isHistorianLogLine(line: string): boolean {
    return HISTORIAN_LOG_PATTERNS.some((rx) => rx.test(line));
}

/**
 */
function extractHistorianFailureLines(sanitized: string, limit = 30): string[] {
    const matches: string[] = [];
    const lines = sanitized.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0 && matches.length < limit; i -= 1) {
        if (isHistorianLogLine(lines[i])) {
            matches.push(lines[i]);
        }
    }
    return matches.reverse();
}

/**
 *
 */
function filterLogLinesBySession(lines: string[], sessionId: string | null): string[] {
    if (!sessionId) return lines;
    // Word boundaries prevent matching `ses_` embedded in longer identifiers.
    const otherSessionPattern = /\bses_[A-Za-z0-9]{8,32}\b/g;
    return lines.filter((line) => {
        const matches = line.match(otherSessionPattern);
        if (!matches) return true;
        return matches.every((id) => id === sessionId);
    });
}

export async function bundleIssueReport(
    report: DiagnosticReport,
    description: string,
    title: string,
    sessionFilter: string | null = null,
): Promise<BundledIssueReport> {
    const LOG_TAIL_LINES = 400;
    const allLogLines = report.logFile.exists
        ? readFileSync(report.logFile.path, "utf-8").split(/\r?\n/)
        : [];
    const logLines = filterLogLinesBySession(allLogLines, sessionFilter);
    const recentLog = sanitizeLogContent(logLines.slice(-LOG_TAIL_LINES).join("\n")).trim();

    // The 4,000-line window includes historian failures outside the 400-line log tail.
    const historianScanWindow = sanitizeLogContent(logLines.slice(-4000).join("\n"));
    const historianFailureLines = extractHistorianFailureLines(historianScanWindow, 30);

    // The 4,000-line window includes errors outside the 400-line log tail.
    const errorScanWindow = sanitizeLogContent(logLines.slice(-4000).join("\n"));
    const recentErrorLines = extractRecentErrors(errorScanWindow, 20);

    const configBody = JSON.stringify(
        sanitizeConfigValue(report.magicContextConfig.flags),
        null,
        2,
    );
    const sanitizedConfigPath = sanitizeDiagnosticText(report.configPaths.magicContextConfig);
    const sanitizedDescription = sanitizeDiagnosticText(description);
    const sanitizedTitle = sanitizeDiagnosticText(title).trim();

    const rawBodyMarkdown = [
        ...(sanitizedTitle ? ["## Title", sanitizedTitle, ""] : []),
        "## Description",
        sanitizedDescription,
        "",
        "## Environment",
        `- Plugin: v${report.pluginVersion}`,
        `- OS: ${report.platform} ${report.arch}`,
        `- Node: ${report.nodeVersion}`,
        `- OpenCode: ${report.opencodeVersion ?? "not installed"}`,
        "",
        "## Configuration",
        `Config from \`${sanitizedConfigPath}\`:`,
        "```jsonc",
        configBody,
        "```",
        "",
        "## Diagnostics",
        renderDiagnosticsMarkdown(report),
        "",
        "## Historian failure signals (log, sanitized)",
        historianFailureLines.length === 0
            ? "_No historian failure log lines found in recent history._"
            : ["```", historianFailureLines.join("\n"), "```"].join("\n"),
        "",
        "## Recent errors (last 20, sanitized)",
        recentErrorLines.length === 0
            ? "_No error-shaped log lines found in recent history._"
            : ["```", recentErrorLines.join("\n"), "```"].join("\n"),
        "",
        `## Log (last ${LOG_TAIL_LINES} lines, sanitized)`,
        "```",
        recentLog || "<no log output>",
        "```",
    ].join("\n");

    const bodyMarkdown = capBodyToGithubLimit(rawBodyMarkdown);

    const path = join(process.cwd(), `magic-context-issue-${formatTimestamp(new Date())}.md`);
    writeFileSync(path, `${bodyMarkdown}\n`);
    return { path, bodyMarkdown };
}
