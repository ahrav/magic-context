import {
    adversarialScenarios,
    runAdversarialScenario,
} from "../src/shared/mc-host-client/test-support/adversarial-scenarios";

let failures = 0;
for (const scenario of adversarialScenarios) {
    try {
        await runAdversarialScenario(scenario);
        console.log(`  ok  ${scenario.name}`);
    } catch (error) {
        failures++;
        const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
        console.log(`FAIL  ${scenario.name}\n${detail}`);
    }
}

if (failures > 0) {
    console.error(`\n${failures}/${adversarialScenarios.length} adversarial scenario(s) failed`);
    process.exit(1);
}
console.log(`\nAll ${adversarialScenarios.length} adversarial scenarios passed.`);
