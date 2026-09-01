#!/usr/bin/env bun
/**
 * Run-mode membership comes from the manifest; refreezing preserves
 * membership while rewriting fingerprints and digests.
 */
import { resolve } from "node:path";
import { currentManifest } from "../src/paired-delta/registry";
import { writeJsonAtomically } from "./atomic-json-write";

const destination = resolve(import.meta.dir, "../pools/paired-delta-manifest.json");
writeJsonAtomically(destination, currentManifest(), "manifest");
console.log(`wrote ${destination}`);
