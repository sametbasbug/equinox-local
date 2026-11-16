export const EQUINOX_LOCAL_NODE_VERSION = "26.13.1";
export const EQUINOX_LOCAL_DUGITE_VERSION = "2.56.1";
export const EQUINOX_LOCAL_DUGITE_BUILD = "238326e";
export const EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION = "0.0.21";
export const EQUINOX_LOCAL_PEEKABOO_VERSION = "4.9.9";
export const EQUINOX_LOCAL_WINAPP_VERSION = "0.8.0";
export const EQUINOX_LOCAL_BUNDLED_WINAPP_SINCE_VERSION = "5.2.1";
export const EQUINOX_LOCAL_NATIVE_JOB_OBJECT_HELPER_SINCE_VERSION = "5.2.1";
export const EQUINOX_LOCAL_NODE_RUNTIME_GATE_SINCE_VERSION = "5.2.1";
export const EQUINOX_LOCAL_BUNDLED_PEEKABOO_SINCE_VERSION = "4.4.0";
export const EQUINOX_LOCAL_PEEKABOO_TEAM_ID = "FWJYW4S8P8";
export const PEEKABOO_DISTRIBUTION = Object.freeze({
    filename: "peekaboo-macos-universal.tar.gz",
    sha256: "6d2780de69058a6c8cf17dd1f9fadefcdf3d4ba0df8365d1f32aa14fefa410fc",
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
        filename: `dugite-native-v2.56.1-${EQUINOX_LOCAL_DUGITE_BUILD}-macOS-arm64.tar.gz`,
        bytes: 63_505_330,
        sha256: "a882ec6882416b57d212a22bac845ae27944f96cf73453a864f6a12c17863a79",
    }),
    "darwin-x64": Object.freeze({
        filename: `dugite-native-v2.56.1-${EQUINOX_LOCAL_DUGITE_BUILD}-macOS-x64.tar.gz`,
        bytes: 67_474_588,
        sha256: "3fdb0c2f102fe0273d64b5d5fb77315c19f2b4648a154593723cb9ed98f2bc7d",
    }),
    "win32-arm64": Object.freeze({
        filename: `dugite-native-v2.56.1-${EQUINOX_LOCAL_DUGITE_BUILD}-windows-arm64.tar.gz`,
        bytes: 44_390_827,
        sha256: "c30eef9fc273f4f56f795b4be713726f8a2fd35832633f4e4b9f51a6f0cf8198",
    }),
    "win32-x64": Object.freeze({
        filename: `dugite-native-v2.56.1-${EQUINOX_LOCAL_DUGITE_BUILD}-windows-x64.tar.gz`,
        bytes: 47_024_188,
        sha256: "e9fa2c78952aa2c2154c26dbd4999f93269896e9fc902fa9fe840412d4ffdb04",
    }),
});
export const NODE_DISTRIBUTIONS = Object.freeze({
    "darwin-arm64": Object.freeze({
        filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-darwin-arm64.tar.gz`,
        bytes: 58_340_590,
        sha256: "aec2514ea1ceb2ba52455e9ec65986f6749a06dd759e5db2a72e6889668c9735",
        fileArchitecture: "arm64",
    }),
    "darwin-x64": Object.freeze({
        filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-darwin-x64.tar.gz`,
        bytes: 59_799_324,
        sha256: "82bb96078a24ca50b9c9a38f2379e6be6d87171fcd400fc14c8934b3bce96e2f",
        fileArchitecture: "x86_64",
    }),
    "win32-arm64": Object.freeze({
        filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-win-arm64.zip`,
        bytes: 37_036_542,
        sha256: "181ebe431b90787113a9e4fc80d38ce86d37888a353a0386de44d2872e48cb97",
        fileArchitecture: "arm64",
    }),
    "win32-x64": Object.freeze({
        filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-win-x64.zip`,
        bytes: 41_166_246,
        sha256: "e2edda75bfb089654705cf65a13b58933bfd5f57148e8ebda916f58a2474f1f7",
        fileArchitecture: "x86_64",
    }),
});
export const TUNNEL_CLIENT_DISTRIBUTIONS = Object.freeze({
    "darwin-arm64": Object.freeze({
        assetTag: "darwin-arm64",
        filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-darwin-arm64.zip`,
        sha256: "353a535d2513f599f9fe7897606e89b3248611453b30203ebddfb6e62fd4f58b",
        fileArchitecture: "arm64",
    }),
    "darwin-x64": Object.freeze({
        assetTag: "darwin-amd64",
        filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-darwin-amd64.zip`,
        sha256: "4aff53fb903374b83284657c39cf940e7cb9cfebfb7b2eb8c2e85da94c583770",
        fileArchitecture: "x86_64",
    }),
    "win32-arm64": Object.freeze({
        assetTag: "windows-arm64",
        filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-windows-arm64.zip`,
        sha256: "6cb625dbc7a9b0e5dc62e4844bd97f421dd88ec0bd135654c66abccd0aa01a5e",
        fileArchitecture: "arm64",
    }),
    "win32-x64": Object.freeze({
        assetTag: "windows-amd64",
        filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-windows-amd64.zip`,
        sha256: "2faf80ae62b58485fcef534cd3f78cd8b82e71cb04d14c2a5c73dbb4eb6c575a",
        fileArchitecture: "x86_64",
    }),
});
