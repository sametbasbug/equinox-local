export const EQUINOX_LOCAL_NODE_VERSION = "26.11.1";
export const EQUINOX_LOCAL_DUGITE_VERSION = "2.53.0-4";
export const EQUINOX_LOCAL_DUGITE_BUILD = "4098283";
export const EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION = "0.0.16";
export const EQUINOX_LOCAL_PEEKABOO_VERSION = "4.9.0";
export const EQUINOX_LOCAL_WINAPP_VERSION = "0.7.1";
export const EQUINOX_LOCAL_BUNDLED_WINAPP_SINCE_VERSION = "5.2.1";
export const EQUINOX_LOCAL_NATIVE_JOB_OBJECT_HELPER_SINCE_VERSION = "5.2.1";
export const EQUINOX_LOCAL_NODE_RUNTIME_GATE_SINCE_VERSION = "5.2.1";
export const EQUINOX_LOCAL_BUNDLED_PEEKABOO_SINCE_VERSION = "4.4.0";
export const EQUINOX_LOCAL_PEEKABOO_TEAM_ID = "FWJYW4S8P8";

export const PEEKABOO_DISTRIBUTION = Object.freeze({
  filename: "peekaboo-macos-universal.tar.gz",
  sha256: "64884da09af4f707267ee5ee7364f31c34bfeb8a6f1404478e1babc9ff412230",
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
    bytes: 58_283_153,
    sha256: "d916511b55965e91be7a88e17f88d895b6793ceaba3e6c9b194aefe51c2c65ac",
    fileArchitecture: "arm64",
  }),
  "darwin-x64": Object.freeze({
    filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-darwin-x64.tar.gz`,
    bytes: 59_713_543,
    sha256: "9a8129bd9ab08039793dd1143a7aedee6b5d60ac06592ad938d8bddf36142f3a",
    fileArchitecture: "x86_64",
  }),
  "win32-arm64": Object.freeze({
    filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-win-arm64.zip`,
    bytes: 37_238_969,
    sha256: "8dd03add3ed431eb436306f9abe946434bce928d2bf967b04117dc3755051208",
    fileArchitecture: "arm64",
  }),
  "win32-x64": Object.freeze({
    filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-win-x64.zip`,
    bytes: 41_809_787,
    sha256: "97f36a8a9684ff0d3e35758b4610fef5b628a5880e96f2ccc11240e5daf9934e",
    fileArchitecture: "x86_64",
  }),
});

export const TUNNEL_CLIENT_DISTRIBUTIONS = Object.freeze({
  "darwin-arm64": Object.freeze({
    assetTag: "darwin-arm64",
    filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-darwin-arm64.zip`,
    sha256: "a160820d45089b5253d8d671fe2a689bde0f73d78c135d1497a7b33f28a3ac62",
    fileArchitecture: "arm64",
  }),
  "darwin-x64": Object.freeze({
    assetTag: "darwin-amd64",
    filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-darwin-amd64.zip`,
    sha256: "57b3dd73f2d042c7aeb5664681f7538078359f55538b9e048640f1df71a0c83f",
    fileArchitecture: "x86_64",
  }),
  "win32-arm64": Object.freeze({
    assetTag: "windows-arm64",
    filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-windows-arm64.zip`,
    sha256: "ecd748288b9bd9cc8f5a963855eb143f4788b831475156703d0bafdcd2dcb149",
    fileArchitecture: "arm64",
  }),
  "win32-x64": Object.freeze({
    assetTag: "windows-amd64",
    filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-windows-amd64.zip`,
    sha256: "edef7241b0c647fcb30f1a80ff376b6b25c51927960f257a3f01e21b17c2aba6",
    fileArchitecture: "x86_64",
  }),
});
