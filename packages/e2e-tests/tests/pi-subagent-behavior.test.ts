/// <reference types="bun-types" />

import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { PiSubagentRunner } from "../../pi-plugin/src/subagent-runner";

const baseOptions = {
    agent: "historian",
    systemPrompt: "hidden subagent system guidance",
    userMessage: "summarize this Pi session",
};

type MockChild = ReturnType<typeof createMockChild>;

function createMockChild() {
    const events = new EventEmitter();
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    let exitCode: number | null = null;
    let signalCode: NodeJS.Signals | null = null;
    const child = {
        pid: 4242,
        stdin: null,
        stdout: stdoutStream,
        stderr: stderrStream,
        get exitCode() {
            return exitCode;
        },
        get signalCode() {
            return signalCode;
        },
        kill: mock((_signal?: NodeJS.Signals | number) => true),
        on: events.on.bind(events),
        once: events.once.bind(events),
        emitClose: (code: number | null = 0, signal: NodeJS.Signals | null = null) => {
            exitCode = code;
            signalCode = signal;
            stdoutStream.end();
            stderrStream.end();
            setTimeout(() => events.emit("close", code, signal), 0);
        },
        writeStdoutLine: (event: unknown) => {
            stdoutStream.write(`${JSON.stringify(event)}\n`);
        },
    };
    return child;
}

function agentEnd(text: string) {
    return {
        type: "agent_end",
        messages: [
            {
                role: "assistant",
                content: [{ type: "text", text }],
                stopReason: "stop",
            },
        ],
    };
}

function runnerWithChildren(children: MockChild[]) {
    let index = 0;
    const spawnImpl = mock(() => children[index++] as never);
    const runner = new PiSubagentRunner({
        piBinary: "pi-test",
        spawnImpl: spawnImpl as never,
    });
    return { runner, spawnImpl };
}

function capturedSpawnCall(
    spawnImpl: { mock: { calls: unknown[] } },
    index: number,
): [string, string[], { env?: NodeJS.ProcessEnv; cwd?: string }] {
    const call = (spawnImpl.mock.calls as Array<unknown>)[index] as
        | [string, string[], { env?: NodeJS.ProcessEnv; cwd?: string }]
        | undefined;
    if (!call) throw new Error(`expected spawn call ${index}`);
    return call;
}

describe("pi subagent behavior", () => {
    it("spawns hidden Pi children with recursion guard, --no-session, and strict tool gates", async () => {
        const historian = createMockChild();
        const unknown = createMockChild();
        const { runner, spawnImpl } = runnerWithChildren([historian, unknown]);

        const historianRun = runner.run({
            ...baseOptions,
            agent: "historian",
            model: "anthropic/claude-sonnet",
            cwd: "/tmp/pi-project",
        });
        historian.writeStdoutLine(agentEnd("historian done"));
        historian.emitClose(0);
        await historianRun;

        expect(spawnImpl).toHaveBeenCalledTimes(1);
        const [, historianArgs, historianOptions] = capturedSpawnCall(spawnImpl, 0);
        expect(historianOptions.cwd).toBe("/tmp/pi-project");
        expect(historianOptions.env).toEqual(
            expect.objectContaining({
                MAGIC_CONTEXT_PI_SUBAGENT: "1",
                PATH: process.env.PATH,
            }),
        );
        expect(historianOptions.env).not.toBe(process.env);
        expect(historianArgs).toContain("--no-session");
        expect(historianArgs).toEqual(expect.arrayContaining(["--tools", "read,grep,find,ls,aft_search"]));
        expect(historianArgs).not.toContain("--no-tools");

        const unknownRun = runner.run({
            ...baseOptions,
            agent: "future-agent",
            model: "anthropic/claude-sonnet",
        });
        unknown.writeStdoutLine(agentEnd("unknown done"));
        unknown.emitClose(0);
        await unknownRun;

        expect(spawnImpl).toHaveBeenCalledTimes(2);
        const [, unknownArgs] = capturedSpawnCall(spawnImpl, 1);
        expect(unknownArgs).toContain("--no-session");
        expect(unknownArgs).toContain("--no-tools");
        expect(unknownArgs).not.toContain("--tools");
    });

    it("propagates overflow-shaped child failures without recursive child spawns", async () => {
        const child = createMockChild();
        const { runner, spawnImpl } = runnerWithChildren([child]);

        const resultPromise = runner.run({
            ...baseOptions,
            agent: "historian",
            model: "anthropic/claude-sonnet",
            cwd: "/tmp/pi-project",
        });
        child.writeStdoutLine({
            type: "message_end",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "provider overflow" }],
                stopReason: "error",
                errorMessage: "This model's maximum context length is 120000 tokens. Please reduce the length of the messages.",
            },
        });
        child.emitClose(0);

        const result = await resultPromise;
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe("model_failed");
            expect(result.error).toContain("maximum context length");
        }
        expect(spawnImpl).toHaveBeenCalledTimes(1);
        const [, args] = capturedSpawnCall(spawnImpl, 0);
        expect(args).toContain("--no-session");
    });
});
