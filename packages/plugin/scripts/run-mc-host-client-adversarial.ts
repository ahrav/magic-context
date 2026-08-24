import {
    adversarialScenarios,
    runAdversarialScenario,
} from "../src/shared/mc-host-client/test-support/adversarial-scenarios";
import {
    frameChannelContractScenarios,
    runFrameChannelContractScenario,
    tcpFrameChannelContractFactory,
} from "../src/shared/mc-host-client/test-support/frame-channel-contract";

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
for (const scenario of frameChannelContractScenarios) {
    try {
        await runFrameChannelContractScenario(scenario, tcpFrameChannelContractFactory);
        console.log(`  ok  [frame-channel contract] ${scenario.name}`);
    } catch (error) {
        failures++;
        const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
        console.log(`FAIL  [frame-channel contract] ${scenario.name}\n${detail}`);
    }
}

const total = adversarialScenarios.length + frameChannelContractScenarios.length;
if (failures > 0) {
    console.error(`\n${failures}/${total} scenario(s) failed`);
    process.exit(1);
}
console.log(`\nAll ${total} adversarial and frame-channel contract scenarios passed.`);
