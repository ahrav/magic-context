import { afterEach, describe, expect, it } from "bun:test";
import {
    _resetKeepSubagentsForTesting,
    setKeepSubagents,
    shouldKeepSubagents,
} from "./keep-subagents";

afterEach(() => {
    _resetKeepSubagentsForTesting();
});

describe("keep-subagents flag", () => {
    it("#given default #then subagent sessions are NOT kept (deleted on success)", () => {
        expect(shouldKeepSubagents()).toBe(false);
    });

    it("#given setKeepSubagents(true) #then sessions are kept", () => {
        setKeepSubagents(true);
        expect(shouldKeepSubagents()).toBe(true);
    });

    it("#given setKeepSubagents(false) #then sessions are not kept", () => {
        setKeepSubagents(true);
        setKeepSubagents(false);
        expect(shouldKeepSubagents()).toBe(false);
    });

    it("#given a non-true value #then coerces to false (only strict true keeps)", () => {
        setKeepSubagents(undefined as unknown as boolean);
        expect(shouldKeepSubagents()).toBe(false);
    });

    it("#given reset helper #then returns to default false", () => {
        setKeepSubagents(true);
        _resetKeepSubagentsForTesting();
        expect(shouldKeepSubagents()).toBe(false);
    });
});
