export const EQUINOX_LOCAL_NODE_VERSION = "26.13.0";
export const EQUINOX_LOCAL_DUGITE_VERSION = "2.56.0-1";
export const EQUINOX_LOCAL_DUGITE_BUILD = "7ce66f8";
export const EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION = "0.0.19";
export const EQUINOX_LOCAL_PEEKABOO_VERSION = "4.9.7";
export const EQUINOX_LOCAL_WINAPP_VERSION = "0.7.1";
export const EQUINOX_LOCAL_BUNDLED_WINAPP_SINCE_VERSION = "5.2.1";
export const EQUINOX_LOCAL_NATIVE_JOB_OBJECT_HELPER_SINCE_VERSION = "5.2.1";
export const EQUINOX_LOCAL_NODE_RUNTIME_GATE_SINCE_VERSION = "5.2.1";
export const EQUINOX_LOCAL_BUNDLED_PEEKABOO_SINCE_VERSION = "4.4.0";
export const EQUINOX_LOCAL_PEEKABOO_TEAM_ID = "FWJYW4S8P8";

export const PEEKABOO_DISTRIBUTION = Object.freeze({
  filename: "peekaboo-macos-universal.tar.gz",
  sha256: "8a4136b9efd4c3a5591840375b024009a3cfb1b5fe994f62268cc755fb37744c",
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
    sha256: "2243d024b77af8ee4b4ab7a1447949e5fc8d82bcd2d51b178927f2da9e47ecfd",
    fileArchitecture: "arm64",
  }),
  "darwin-x64": Object.freeze({
    assetTag: "darwin-amd64",
    filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-darwin-amd64.zip`,
    sha256: "dff97674c77cac59e6ab3d901e6cff50fb17a5784c01d8959d1f4adb3afdf4bf",
    fileArchitecture: "x86_64",
  }),
  "win32-arm64": Object.freeze({
    assetTag: "windows-arm64",
    filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-windows-arm64.zip`,
    sha256: "a054bfb19d72b446cc9802a7987a17eab517502355d27b18e51814bbb0b32731",
    fileArchitecture: "arm64",
  }),
  "win32-x64": Object.freeze({
    assetTag: "windows-amd64",
    filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-windows-amd64.zip`,
    sha256: "1d0ecc3a54f2a51e27a635ac155f40fbb95df58c52cdeddf6c75532cc0bbeb25",
    fileArchitecture: "x86_64",
  }),
});
