export const EQUINOX_LOCAL_NODE_VERSION = "26.10.0";
export const EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION = "0.0.15";
export const EQUINOX_LOCAL_PEEKABOO_VERSION = "4.5.0";
export const EQUINOX_LOCAL_BUNDLED_PEEKABOO_SINCE_VERSION = "4.4.0";
export const EQUINOX_LOCAL_PEEKABOO_TEAM_ID = "FWJYW4S8P8";

export const PEEKABOO_DISTRIBUTION = Object.freeze({
  filename: "peekaboo-macos-universal.tar.gz",
  sha256: "10b409423e5540235c59ef6c3c39d31e236ac528f8b7e116b9ed5a086a1c454e",
  archiveRoot: "peekaboo-macos-universal",
  architectures: Object.freeze(["arm64", "x86_64"]),
});

export const NODE_DISTRIBUTIONS = Object.freeze({
  "darwin-arm64": Object.freeze({
    filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: "751fdf7439f115d87ee2a8f3f18c065b6151852068e3e666ac60ac2996f75ac9",
    fileArchitecture: "arm64",
  }),
  "darwin-x64": Object.freeze({
    filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-darwin-x64.tar.gz`,
    sha256: "ebbe9ab9b58ad6bb54390d6e2c862c1afa7d4475fb7e8ae8146acde211bf70df",
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
});
