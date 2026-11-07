export const EQUINOX_LOCAL_NODE_VERSION = "26.13.0";
export const EQUINOX_LOCAL_DUGITE_VERSION = "2.56.0-2";
export const EQUINOX_LOCAL_DUGITE_BUILD = "a44aeca";
export const EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION = "0.0.20";
export const EQUINOX_LOCAL_PEEKABOO_VERSION = "4.9.8";
export const EQUINOX_LOCAL_WINAPP_VERSION = "0.8.0";
export const EQUINOX_LOCAL_BUNDLED_WINAPP_SINCE_VERSION = "5.2.1";
export const EQUINOX_LOCAL_NATIVE_JOB_OBJECT_HELPER_SINCE_VERSION = "5.2.1";
export const EQUINOX_LOCAL_NODE_RUNTIME_GATE_SINCE_VERSION = "5.2.1";
export const EQUINOX_LOCAL_BUNDLED_PEEKABOO_SINCE_VERSION = "4.4.0";
export const EQUINOX_LOCAL_PEEKABOO_TEAM_ID = "FWJYW4S8P8";
export const PEEKABOO_DISTRIBUTION = Object.freeze({
    filename: "peekaboo-macos-universal.tar.gz",
    sha256: "88823bb39e16c744c43ffd94c18c3773cd2f7c05bc7843e6e1e2e5da58b9ce76",
    archiveRoot: "peekaboo-macos-universal",
    architectures: Object.freeze(["arm64", "x86_64"]),
});
export const WINAPP_DISTRIBUTIONS = Object.freeze({
    "win32-arm64": Object.freeze({
        filename: `winappcli-arm64.zip`,
        sha256: "fbbb2f83228b5130978c17051a9a18e72ea169426cc547de1a17f6cde707561f",
        fileArchitecture: "arm64",
    }),
    "win32-x64": Object.freeze({
        filename: `winappcli-x64.zip`,
        sha256: "67a8e1d39421a5ef5309c7017327c6a70ea6215a0e56e47ec22a7e9ec3b914e6",
        fileArchitecture: "x86_64",
    }),
});
export const DUGITE_DISTRIBUTIONS = Object.freeze({
    "darwin-arm64": Object.freeze({
        filename: `dugite-native-v2.56.0-${EQUINOX_LOCAL_DUGITE_BUILD}-macOS-arm64.tar.gz`,
        bytes: 63_488_287,
        sha256: "1110de343de11cc6f469b782b60f36217b9199b5e06875dd65baa26dd60563c7",
    }),
    "darwin-x64": Object.freeze({
        filename: `dugite-native-v2.56.0-${EQUINOX_LOCAL_DUGITE_BUILD}-macOS-x64.tar.gz`,
        bytes: 67_470_398,
        sha256: "52cc663281e1ec2f1d76ba781193ca4847e62dbbf767f6c99ec9ec5b978a7659",
    }),
    "win32-arm64": Object.freeze({
        filename: `dugite-native-v2.56.0-${EQUINOX_LOCAL_DUGITE_BUILD}-windows-arm64.tar.gz`,
        bytes: 44_393_170,
        sha256: "1834e7817589f25f97ae0f309ef4733578a6b8dbd438ed29f898d075e6ead4c2",
    }),
    "win32-x64": Object.freeze({
        filename: `dugite-native-v2.56.0-${EQUINOX_LOCAL_DUGITE_BUILD}-windows-x64.tar.gz`,
        bytes: 47_023_615,
        sha256: "f1e17876337d7be143e5d51976da36643d65528125cfbc14d57f171de0fd5f14",
    }),
});
export const NODE_DISTRIBUTIONS = Object.freeze({
    "darwin-arm64": Object.freeze({
        filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-darwin-arm64.tar.gz`,
        bytes: 58_334_661,
        sha256: "d38bd5e5a2ddce6bbb5ce45e46e208337da4d51fffe611e567fd32073d6439f6",
        fileArchitecture: "arm64",
    }),
    "darwin-x64": Object.freeze({
        filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-darwin-x64.tar.gz`,
        bytes: 59_802_926,
        sha256: "525c9b29bb0263d687de60a4cec0e2a6db876a8eb032369e5795eca71e7c358e",
        fileArchitecture: "x86_64",
    }),
    "win32-arm64": Object.freeze({
        filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-win-arm64.zip`,
        bytes: 37_005_985,
        sha256: "a9427139595156ef484e1fb08957676e09d4232368dd1743a2a9f93f3d241b14",
        fileArchitecture: "arm64",
    }),
    "win32-x64": Object.freeze({
        filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-win-x64.zip`,
        bytes: 41_157_375,
        sha256: "dcc60d59a0746999f99064a01c020445d54d84228c691cdbf25b49ac3b59150a",
        fileArchitecture: "x86_64",
    }),
});
export const TUNNEL_CLIENT_DISTRIBUTIONS = Object.freeze({
    "darwin-arm64": Object.freeze({
        assetTag: "darwin-arm64",
        filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-darwin-arm64.zip`,
        sha256: "f4689e75a835f69f1bbb9c59de9c4debb8e9c9cbbdd2721aa93378b4b048fd33",
        fileArchitecture: "arm64",
    }),
    "darwin-x64": Object.freeze({
        assetTag: "darwin-amd64",
        filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-darwin-amd64.zip`,
        sha256: "a8933a472c18409d137fbdece70673dbd23446754fea88eb9e5653d3244b93eb",
        fileArchitecture: "x86_64",
    }),
    "win32-arm64": Object.freeze({
        assetTag: "windows-arm64",
        filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-windows-arm64.zip`,
        sha256: "24fdcc4f71d1c2269c4df349339ece2a0d1053de046be93b039af5d2c09d933b",
        fileArchitecture: "arm64",
    }),
    "win32-x64": Object.freeze({
        assetTag: "windows-amd64",
        filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-windows-amd64.zip`,
        sha256: "99474aaa62ece303d7b661f2f46f932dcd560b489b540f817355da25be71bcf3",
        fileArchitecture: "x86_64",
    }),
});
