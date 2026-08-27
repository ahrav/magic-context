/**
 * Benchmark-layer alias for the frozen physical result-locator codec.
 *
 * The codec itself lives in production
 * (`src/features/magic-context/physical-result-locator.ts`) so measurement writes
 * and benchmark reads share exactly one encoder; this module only re-exports it
 * for the benchmark's importers. Scripts may depend on `src`, never the reverse.
 */

export {
    encodePhysicalResultLocator,
    parsePhysicalResultLocator,
    PHYSICAL_LOCATOR_KINDS,
    type PhysicalLocatorKind,
    type PhysicalLocatorParse,
    type PhysicalResultLocator,
    SOURCE_LOCATOR_KIND,
} from "../../src/features/magic-context/physical-result-locator";
