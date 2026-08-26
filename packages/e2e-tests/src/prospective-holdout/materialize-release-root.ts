import { constants } from "node:fs";
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    renameSync,
    rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { HoldoutContractError } from "./contract";
import { withRecoverableLock } from "./lock";
import {
    type ReleaseRootManifest,
    type VerifiedReleaseRoot,
    verifyReleaseRoot,
} from "./release-root";

function chmodDirectories(root: string, mode: number): void {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) chmodDirectories(join(root, entry.name), mode);
    }
    chmodSync(root, mode);
}

export function materializeReleaseRoot(input: {
    promotedRoot: string;
    destination: string;
    manifest: ReleaseRootManifest;
    expectedRootFingerprint: string;
    activeCheckout: string;
}): VerifiedReleaseRoot {
    const source = verifyReleaseRoot(input.promotedRoot, input.manifest, {
        expectedRootFingerprint: input.expectedRootFingerprint,
        activeCheckout: input.activeCheckout,
    });
    const destination = resolve(input.destination);
    const parent = dirname(destination);
    mkdirSync(parent, { recursive: true });
    const staging = mkdtempSync(join(parent, `.${basename(destination)}.staging-`));
    let published = false;
    try {
        for (const file of source.manifest.files) {
            const from = resolve(source.root, file.path);
            const to = resolve(staging, file.path);
            mkdirSync(dirname(to), { recursive: true });
            copyFileSync(from, to, constants.COPYFILE_EXCL);
            chmodSync(to, file.path === source.manifest.entrypoints.rustHost ? 0o555 : 0o444);
        }
        verifyReleaseRoot(staging, source.manifest, {
            expectedRootFingerprint: source.observedRootFingerprint,
            activeCheckout: input.activeCheckout,
        });
        chmodDirectories(staging, 0o555);

        // The lock lives beside `destination` in the parent this function already
        // created, and guards the gap between the existence check and the rename so
        // two materializations cannot both see an absent destination. Recoverable
        // acquisition is what keeps a worker killed mid-publication from wedging the
        // destination: the surviving directory is reclaimed once its recorded holder
        // is provably dead and past its lease, rather than reporting the busy code to
        // every later attempt forever.
        const lock = join(parent, `.${basename(destination)}.publish-lock`);
        withRecoverableLock(lock, { busyCode: "release-root-materialize: publication-busy" }, () => {
            if (existsSync(destination)) {
                throw new HoldoutContractError(["release-root-materialize: destination-exists"]);
            }
            renameSync(staging, destination);
            published = true;
        });
        return verifyReleaseRoot(destination, source.manifest, {
            expectedRootFingerprint: source.observedRootFingerprint,
            activeCheckout: input.activeCheckout,
        });
    } finally {
        if (!published && existsSync(staging)) {
            chmodDirectories(staging, 0o700);
            rmSync(staging, { recursive: true, force: true });
        }
    }
}
