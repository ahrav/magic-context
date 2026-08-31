import { parseScenarioDeclaration } from "../contract";
import { compactionDeployRegion } from "./compaction-deploy-region";
import { compactionFeatureState } from "./compaction-feature-state";
import { compactionSchemaVersion } from "./compaction-schema-version";
import { exactPath } from "./exact-path";
import { exactSymbol } from "./exact-symbol";
import { exactTicket } from "./exact-ticket";
import { rejectedDatabase } from "./rejected-database";
import { rejectedQueue } from "./rejected-queue";
import { supersededOwner } from "./superseded-owner";
import { supersededTimeout } from "./superseded-timeout";

export const pairedDeltaScenarios = [
    compactionDeployRegion,
    compactionSchemaVersion,
    compactionFeatureState,
    exactSymbol,
    exactPath,
    exactTicket,
    supersededTimeout,
    supersededOwner,
    rejectedDatabase,
    rejectedQueue,
].map(parseScenarioDeclaration);
