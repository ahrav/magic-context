/**
 * Runtime-neutral adversarial scenario harness.
 *
 * Each scenario drives a real `ConnectionGeneration` against the
 * independent `FakePeer` using `node:assert/strict` only — no bun:test —
 * so the same scenarios also execute under Node 24. `connection.test.ts`
 * wraps every scenario in a bun test and adds bun-specific cases on top.
 */
import { type ScenarioContext } from "./test-util";
export interface AdversarialScenario {
    name: string;
    run(ctx: ScenarioContext): Promise<void>;
}
/** Run one scenario with automatic peer/generation cleanup. */
export declare function runAdversarialScenario(scenario: AdversarialScenario): Promise<void>;
export declare const adversarialScenarios: readonly AdversarialScenario[];
//# sourceMappingURL=adversarial-scenarios.d.ts.map