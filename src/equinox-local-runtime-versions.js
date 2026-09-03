export const EQUINOX_LOCAL_NODE_VERSION = "24.20.0";
export const EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION = "0.0.14";
export const EQUINOX_LOCAL_PEEKABOO_VERSION = "4.3.0";
export const EQUINOX_LOCAL_BUNDLED_PEEKABOO_SINCE_VERSION = "4.4.0";
export const EQUINOX_LOCAL_PEEKABOO_TEAM_ID = "FWJYW4S8P8";

export const PEEKABOO_DISTRIBUTION = Object.freeze({
  filename: "peekaboo-macos-universal.tar.gz",
  sha256: "fec965e4bd6371b8fb017fb582e8d31c6a59628f77e266878f45cf1d4844836f",
  archiveRoot: "peekaboo-macos-universal",
  architectures: Object.freeze(["arm64", "x86_64"]),
});

export const NODE_DISTRIBUTIONS = Object.freeze({
  "darwin-arm64": Object.freeze({
    filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: "40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8",
    fileArchitecture: "arm64",
  }),
  "darwin-x64": Object.freeze({
    filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-darwin-x64.tar.gz`,
    sha256: "9e5b2644cf107befb6aefca676b96d3296bc10138096f022ed378d6233ed81f4",
    fileArchitecture: "x86_64",
  }),
});

export const TUNNEL_CLIENT_DISTRIBUTIONS = Object.freeze({
  "darwin-arm64": Object.freeze({
    assetTag: "darwin-arm64",
    filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-darwin-arm64.zip`,
    sha256: "b540493c5bdbcdbb755700c8e2e16597e28b1569e425007e0f73111047bd6a64",
    fileArchitecture: "arm64",
  }),
  "darwin-x64": Object.freeze({
    assetTag: "darwin-amd64",
    filename: `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-darwin-amd64.zip`,
    sha256: "75e10be774184fb42189e347b16eb6bc9fb0780135d8af714d34e30ce068dc53",
    fileArchitecture: "x86_64",
  }),
});
