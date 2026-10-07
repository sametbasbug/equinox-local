export const EQUINOX_LOCAL_NODE_VERSION = "26.10.0";
export const EQUINOX_LOCAL_DUGITE_VERSION = "2.53.0-4";
export const EQUINOX_LOCAL_DUGITE_BUILD = "4098283";
export const EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION = "0.0.15";
export const EQUINOX_LOCAL_PEEKABOO_VERSION = "4.5.0";
export const EQUINOX_LOCAL_WINAPP_VERSION = "0.7.1";
export const EQUINOX_LOCAL_BUNDLED_WINAPP_SINCE_VERSION = "5.2.1";
export const EQUINOX_LOCAL_NATIVE_JOB_OBJECT_HELPER_SINCE_VERSION = "5.2.1";
export const EQUINOX_LOCAL_NODE_RUNTIME_GATE_SINCE_VERSION = "5.2.1";
export const EQUINOX_LOCAL_BUNDLED_PEEKABOO_SINCE_VERSION = "4.4.0";
export const EQUINOX_LOCAL_PEEKABOO_TEAM_ID = "FWJYW4S8P8";

export const PEEKABOO_DISTRIBUTION = Object.freeze({
  filename: "peekaboo-macos-universal.tar.gz",
  sha256: "10b409423e5540235c59ef6c3c39d31e236ac528f8b7e116b9ed5a086a1c454e",
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
    filename: `dugite-native-v2.53.0-${EQUINOX_LOCAL_DUGITE_BUILD}-macOS-arm64.tar.gz`,
    bytes: 62_348_987,
    sha256: "f9dc64635a5b62fbd7ad95db73268bbb8912255ac516d65d37bf7af22fcb8ffe",
  }),
  "darwin-x64": Object.freeze({
    filename: `dugite-native-v2.53.0-${EQUINOX_LOCAL_DUGITE_BUILD}-macOS-x64.tar.gz`,
    bytes: 66_136_060,
    sha256: "ae6686718aa34f4140424db16b92a47dcffd6d1f312eb8b5f3b267f7404e2680",
  }),
  "win32-arm64": Object.freeze({
    filename: `dugite-native-v2.53.0-${EQUINOX_LOCAL_DUGITE_BUILD}-windows-arm64.tar.gz`,
    bytes: 45_084_825,
    sha256: "1abbeb3a2ce06e9b80e75bb888dce959b6c73bdb11ccc670a01a71d64f4422a5",
  }),
  "win32-x64": Object.freeze({
    filename: `dugite-native-v2.53.0-${EQUINOX_LOCAL_DUGITE_BUILD}-windows-x64.tar.gz`,
    bytes: 47_119_821,
    sha256: "7b76bc5c32c0d7c5984efdc2a8a32697cf1e8a43bc55176fbf9869c0ee995130",
  }),
});

export const NODE_DISTRIBUTIONS = Object.freeze({
  "darwin-arm64": Object.freeze({
    filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-darwin-arm64.tar.gz`,
    bytes: 58_175_384,
    sha256: "751fdf7439f115d87ee2a8f3f18c065b6151852068e3e666ac60ac2996f75ac9",
    fileArchitecture: "arm64",
  }),
  "darwin-x64": Object.freeze({
    filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-darwin-x64.tar.gz`,
    bytes: 59_578_150,
    sha256: "ebbe9ab9b58ad6bb54390d6e2c862c1afa7d4475fb7e8ae8146acde211bf70df",
    fileArchitecture: "x86_64",
  }),
  "win32-arm64": Object.freeze({
    filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-win-arm64.zip`,
    bytes: 37_149_989,
    sha256: "b778640d7271566bcaa9679912cdf0684c13e824c114e41a8b696fb14af7a7aa",
    fileArchitecture: "arm64",
  }),
  "win32-x64": Object.freeze({
    filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-win-x64.zip`,
    bytes: 41_688_989,
    sha256: "9fef7eca6743a6b910989cd8e78712376b394fcb9b6e1e9c44a0799a287f90c5",
    fileArchitecture: "x86_64",
  }),
});

export const TUNNEL_CLIENT_DISTRIBUTIONS = Object.freeze({
  "darwin-arm64": Object.freeze({
    assetTag: "darwin-arm64",
    filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-darwin-arm64.zip`,
    sha256: "b2cae3aa9df45b4c2fe9b1d700ebacce39f9feb6a6b46b86e6499f9a51bf72ff",
    fileArchitecture: "arm64",
  }),
  "darwin-x64": Object.freeze({
    assetTag: "darwin-amd64",
    filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-darwin-amd64.zip`,
    sha256: "9dcae1e2fb121287e73271edb7b853dda52aa86b7bfca1df91bc275371261bdb",
    fileArchitecture: "x86_64",
  }),
  "win32-arm64": Object.freeze({
    assetTag: "windows-arm64",
    filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-windows-arm64.zip`,
    sha256: "571e0d59ed9e86d1b105dc34f3267865f654de6968b01efd7c847f0af657d11d",
    fileArchitecture: "arm64",
  }),
  "win32-x64": Object.freeze({
    assetTag: "windows-amd64",
    filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-windows-amd64.zip`,
    sha256: "3b53133a1e24d43f63088d843860cb1701a4c3ed6390de2e19f69089e43bddc1",
    fileArchitecture: "x86_64",
  }),
});
