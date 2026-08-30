import {
    createManagedLifecyclePolicy,
    type DaemonResultV1,
    type LifecycleCommand,
    resolveLifecycleDataRoot,
    sensitiveRootsFor,
} from "@magic-context/core/shared/mc-host-lifecycle";
import { sanitizeDiagnosticText } from "../lib/redaction";

const ACTIONS = new Set<LifecycleCommand>(["start", "stop", "restart", "status", "doctor"]);

/** Display bound for peer-supplied version text, matching the shared
 *  diagnostic-string limit used by the mc-host client. */
const MAX_VERSION_TEXT_LEN = 128;

/** C0 and C1 control characters (including ESC and newlines): peer-supplied
 *  version text must not be able to move the cursor, erase lines, or forge
 *  additional output lines in the terminal. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: neutralizing them is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

interface DaemonPolicy {
    start(): Promise<DaemonResultV1>;
    stop(): Promise<DaemonResultV1>;
    restart(): Promise<DaemonResultV1>;
    status(): Promise<DaemonResultV1>;
    doctor(): Promise<DaemonResultV1>;
}

export interface DaemonCommandDependencies {
    createPolicy: (
        env: Record<string, string | undefined>,
        action: LifecycleCommand,
    ) => DaemonPolicy;
    stdout: (line: string) => void;
    stderr: (line: string) => void;
    env: Record<string, string | undefined>;
}

const defaultDependencies: DaemonCommandDependencies = {
    createPolicy: (env, action) =>
        createManagedLifecyclePolicy({
            mode: action === "status" || action === "doctor" ? "observational" : "mutating",
            declaringModuleUrl: import.meta.url,
            parentPackageName: "@cortexkit/magic-context",
            env,
        }),
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    env: process.env,
};

function usage(): string {
    return "Usage: magic-context daemon <start|stop|restart|status|doctor> [--json]";
}

function parseArgs(args: string[]): { action: LifecycleCommand; json: boolean } | null {
    if (args.length < 1 || args.length > 2) return null;
    const [action, option] = args;
    if (action === undefined || !ACTIONS.has(action as LifecycleCommand)) return null;
    if (option !== undefined && option !== "--json") return null;
    return { action: action as LifecycleCommand, json: option === "--json" };
}

async function invoke(policy: DaemonPolicy, action: LifecycleCommand): Promise<DaemonResultV1> {
    switch (action) {
        case "start":
            return policy.start();
        case "stop":
            return policy.stop();
        case "restart":
            return policy.restart();
        case "status":
            return policy.status();
        case "doctor":
            return policy.doctor();
    }
}

function redactResult(
    result: DaemonResultV1,
    env: Record<string, string | undefined>,
): DaemonResultV1 {
    const root = resolveLifecycleDataRoot(env);
    const sensitiveRoots = root.ok ? sensitiveRootsFor(root.root, env) : [];
    const redact = (value: string | null): string | null => {
        if (value === null) return null;
        // Failures inside the redaction chain (e.g. os.userInfo() throwing for
        // a UID with no passwd entry) must not reject the command: the v1
        // output contract requires exactly one result object, so fall back to
        // a placeholder instead of leaking or throwing.
        try {
            // Replace every occurrence of each sensitive root, not just a
            // leading prefix: version text is free-form and may embed a path
            // mid-string (R35 requires no such path reaches output).
            let redacted = value;
            for (const sensitiveRoot of sensitiveRoots) {
                redacted = redacted.split(sensitiveRoot).join("<data-root>");
            }
            redacted = sanitizeDiagnosticText(redacted).replace(CONTROL_CHARS, " ");
            return redacted.length > MAX_VERSION_TEXT_LEN
                ? redacted.slice(0, MAX_VERSION_TEXT_LEN)
                : redacted;
        } catch {
            return "<REDACTED>";
        }
    };
    return {
        ...result,
        versions: {
            release: redact(result.versions.release),
            proof: redact(result.versions.proof),
            daemon: redact(result.versions.daemon),
            magic_context: redact(result.versions.magic_context),
            synapse: redact(result.versions.synapse),
            broca: redact(result.versions.broca),
        },
    };
}

export function renderDaemonHuman(result: DaemonResultV1): string {
    const lines = [`Daemon ${result.command}: ${result.state} (${result.reason})`];
    if (result.remediation !== null) {
        lines.push(`Remediation: ${result.remediation}`);
    }
    if (result.effects !== null) {
        lines.push(
            `Effects: stop_committed=${result.effects.stop_committed} start_committed=${result.effects.start_committed}`,
        );
    }
    if (result.readiness !== null) {
        for (const component of ["shared_memory", "storage", "synapse"] as const) {
            const readiness = result.readiness[component];
            if (readiness !== undefined) {
                lines.push(`Readiness ${component}: ${readiness.state} (${readiness.reason})`);
            }
        }
    }
    if (result.shared_memory !== null) {
        const diagnostic = result.shared_memory;
        lines.push(
            `Shared memory: ${diagnostic.state}${diagnostic.error_class === null ? "" : ` (${diagnostic.error_class})`}`,
        );
        lines.push(
            `Ring artifact: profile=${diagnostic.artifact.profile} wire=${diagnostic.artifact.wire_version} descriptor=${diagnostic.artifact.descriptor_schema}`,
        );
        lines.push(
            `Ring accounting: active_bytes=${diagnostic.accounting?.active.arena_bytes ?? "unknown"} quarantined_bytes=${diagnostic.accounting?.quarantined.arena_bytes ?? "unknown"} bound_bytes=${diagnostic.bounds.arena_bytes}`,
        );
        lines.push(
            `Ring lifecycle: activations=${diagnostic.activation.completed} peer_deaths=${diagnostic.peer_death.observed} reclamations=${diagnostic.reclamation.completed} exhaustions=${diagnostic.exhaustion.observed}`,
        );
    }
    for (const check of result.checks) {
        const remediation = check.remediation === null ? "" : ` remediation=${check.remediation}`;
        lines.push(`Check ${check.id}: ${check.status} (${check.reason})${remediation}`);
    }
    const versions = Object.entries(result.versions)
        .filter((entry): entry is [string, string] => entry[1] !== null)
        .map(([name, value]) => `${name}=${value}`);
    if (versions.length > 0) {
        lines.push(`Versions: ${versions.join(" ")}`);
    }
    return lines.join("\n");
}

export async function runDaemonCommand(
    args: string[],
    dependencies: DaemonCommandDependencies = defaultDependencies,
): Promise<number> {
    const parsed = parseArgs(args);
    if (parsed === null) {
        dependencies.stderr(usage());
        return 2;
    }

    let result: DaemonResultV1;
    try {
        const policy = dependencies.createPolicy(dependencies.env, parsed.action);
        result = await invoke(policy, parsed.action);
    } catch {
        dependencies.stderr(
            `Daemon ${parsed.action} failed before a lifecycle result could be formed.`,
        );
        return 1;
    }

    // Redaction and rendering must not reject the command: an escaped throw
    // would exit without any v1 object, violating the one-result contract.
    let rendered: string;
    let ok: boolean;
    try {
        const redacted = redactResult(result, dependencies.env);
        rendered = parsed.json ? JSON.stringify(redacted) : renderDaemonHuman(redacted);
        ok = redacted.ok;
    } catch {
        dependencies.stderr(
            `Daemon ${parsed.action} produced a result that could not be rendered safely.`,
        );
        return 1;
    }
    dependencies.stdout(rendered);
    return ok ? 0 : 1;
}
