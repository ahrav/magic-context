export declare const qualifiedHarnessClosures: {
    readonly harnesses: {
        readonly opencode: {
            readonly anchors: {
                readonly runtime: {
                    readonly from: "executable";
                    readonly source_path: "opencode.exe";
                };
            };
            readonly manifest_sha256: "e7e86cd1e1e639fb60aed6dfc3c33cd04244f767f6681a13bf26c90429279f2d";
            readonly platforms: readonly ["linux-x64-gnu"];
            readonly source_roots: readonly ["runtime"];
        };
        readonly pi: {
            readonly anchors: {
                readonly "pi-install": {
                    readonly from: "entrypoint";
                    readonly source_path: "node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
                };
                readonly runtime: {
                    readonly from: "interpreter";
                    readonly source_path: "node";
                };
            };
            readonly manifest_sha256: "cc87481ce798bd84b9cd0d1dd809bc4c72cea9435303705362a3b2be493674e6";
            readonly platforms: readonly ["linux-x64-gnu"];
            readonly source_roots: readonly ["pi-install", "runtime"];
        };
    };
    readonly schema: "magic-context.mc-host-harness-closure/v1";
};
//# sourceMappingURL=generated-production-inputs.d.ts.map