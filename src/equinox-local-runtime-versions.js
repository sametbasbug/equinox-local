export const EQUINOX_LOCAL_NODE_VERSION = "26.12.1";
export const EQUINOX_LOCAL_DUGITE_VERSION = "2.56.0-1";
export const EQUINOX_LOCAL_DUGITE_BUILD = "7ce66f8";
export const EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION = "0.0.17";
export const EQUINOX_LOCAL_PEEKABOO_VERSION = "4.9.6";
export const EQUINOX_LOCAL_WINAPP_VERSION = "0.7.1";
export const EQUINOX_LOCAL_BUNDLED_WINAPP_SINCE_VERSION = "5.2.1";
export const EQUINOX_LOCAL_NATIVE_JOB_OBJECT_HELPER_SINCE_VERSION = "5.2.1";
export const EQUINOX_LOCAL_NODE_RUNTIME_GATE_SINCE_VERSION = "5.2.1";
export const EQUINOX_LOCAL_BUNDLED_PEEKABOO_SINCE_VERSION = "4.4.0";
export const EQUINOX_LOCAL_PEEKABOO_TEAM_ID = "FWJYW4S8P8";
export const PEEKABOO_DISTRIBUTION = Object.freeze({
    filename: "peekaboo-macos-universal.tar.gz",
    sha256: "01bdd139b7b010630378bbf0e31f54f38fde4501a5805b2bf66b64521b7ceca2",
    archiveRoot: "peekaboo-macos-universal",
    architectures: Object.freeze(["arm64", "x86_64"]),
});
export const WINAPP_DISTRIBUTIONS = Object.freeze({
    "win32-arm64": Object.freeze({
        filename: `winappcli-arm64.zip`,
        sha256: "4ed1edcc6d4a1a7c75bb70dbdbf77a69b3c650823c7e8061aa66f8adb1017f2e",
        fileArchitecture: "arm64",
    }),
    "win32-x64": Object.freeze({
        filename: `winappcli-x64.zip`,
        sha256: "d925d1e32cdc320b6d271f653fd2cd3c05b5d7558deb20d1b548bead77900fcf",
        fileArchitecture: "x86_64",
    }),
});
export const DUGITE_DISTRIBUTIONS = Object.freeze({
    "darwin-arm64": Object.freeze({
        filename: `dugite-native-v2.56.0-${EQUINOX_LOCAL_DUGITE_BUILD}-macOS-arm64.tar.gz`,
        bytes: 63_488_157,
        sha256: "ab756ab9a15241f14b6c0a0386c704a998bb710a837ab35dc55d4747a90f2ca0",
    }),
    "darwin-x64": Object.freeze({
        filename: `dugite-native-v2.56.0-${EQUINOX_LOCAL_DUGITE_BUILD}-macOS-x64.tar.gz`,
        bytes: 67_470_255,
        sha256: "f294895790a98405b2900d55160945d4d0ce92492891aac4b95f2c7085220fa3",
    }),
    "win32-arm64": Object.freeze({
        filename: `dugite-native-v2.56.0-${EQUINOX_LOCAL_DUGITE_BUILD}-windows-arm64.tar.gz`,
        bytes: 44_348_850,
        sha256: "bd8ecc89890421684d9b49951af162725389a43b9f128350daff673116af5726",
    }),
    "win32-x64": Object.freeze({
        filename: `dugite-native-v2.56.0-${EQUINOX_LOCAL_DUGITE_BUILD}-windows-x64.tar.gz`,
        bytes: 46_985_154,
        sha256: "2157566523b767a8f812a6733686fdf13046aa9c1d9987f96030401b759bffee",
    }),
});
export const NODE_DISTRIBUTIONS = Object.freeze({
    "darwin-arm64": Object.freeze({
        filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-darwin-arm64.tar.gz`,
        bytes: 58_334_853,
        sha256: "1901d539912c02afa10d1cc126943a8855a7eedebe830119463470db5e6c59e8",
        fileArchitecture: "arm64",
    }),
    "darwin-x64": Object.freeze({
        filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-darwin-x64.tar.gz`,
        bytes: 59_800_211,
        sha256: "b85c2ea4420ad0bc4abf2dc6cf1f55130ed681f1cabf60cf3f526e4c9e2712ff",
        fileArchitecture: "x86_64",
    }),
    "win32-arm64": Object.freeze({
        filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-win-arm64.zip`,
        bytes: 37_275_911,
        sha256: "34567581ee63967b37afb6b7a0cc63a2d550a43d5d838adb75982d7e356f2e2c",
        fileArchitecture: "arm64",
    }),
    "win32-x64": Object.freeze({
        filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-win-x64.zip`,
        bytes: 41_901_456,
        sha256: "b3efd5c70cba3308ed46e7e699a9b8aac075bbc6b027fcb39c84c31acc25e2b4",
        fileArchitecture: "x86_64",
    }),
});
export const TUNNEL_CLIENT_DISTRIBUTIONS = Object.freeze({
    "darwin-arm64": Object.freeze({
        assetTag: "darwin-arm64",
        filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-darwin-arm64.zip`,
        sha256: "df03ad0ba9c95c22951bab6833df289469f15b9a3fa0397d95e3d568d1ff6c1f",
        fileArchitecture: "arm64",
    }),
    "darwin-x64": Object.freeze({
        assetTag: "darwin-amd64",
        filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-darwin-amd64.zip`,
        sha256: "1d54cc57e0a624dc733d402f7d36585f2135a23ddc32c4cb52a7253c7d8d94a0",
        fileArchitecture: "x86_64",
    }),
    "win32-arm64": Object.freeze({
        assetTag: "windows-arm64",
        filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-windows-arm64.zip`,
        sha256: "925c8298e46e088413bb02c81d36775f2e818970231bc2ecc215fcb0f0382bf7",
        fileArchitecture: "arm64",
    }),
    "win32-x64": Object.freeze({
        assetTag: "windows-amd64",
        filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-windows-amd64.zip`,
        sha256: "b89074637596262067061308cf174959561a1a8bcffe2db956650dad7303052b",
        fileArchitecture: "x86_64",
    }),
});
