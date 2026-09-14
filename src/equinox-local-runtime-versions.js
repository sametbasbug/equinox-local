export const EQUINOX_LOCAL_NODE_VERSION = "26.8.2";
export const EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION = "0.0.14";
export const EQUINOX_LOCAL_PEEKABOO_VERSION = "4.4.0";
export const EQUINOX_LOCAL_BUNDLED_PEEKABOO_SINCE_VERSION = "4.4.0";
export const EQUINOX_LOCAL_PEEKABOO_TEAM_ID = "FWJYW4S8P8";

export const PEEKABOO_DISTRIBUTION = Object.freeze({
  filename: "peekaboo-macos-universal.tar.gz",
  sha256: "6260d3560dc05b8df6621ffac5544ff987291105842ffeb652ecf018ec725d45",
  archiveRoot: "peekaboo-macos-universal",
  architectures: Object.freeze(["arm64", "x86_64"]),
});

export const NODE_DISTRIBUTIONS = Object.freeze({
  "darwin-arm64": Object.freeze({
    filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: "974b6d5fb2fc7c33ff2354db0902b4e91c2de01ec8acc6de48e543c97e18c9e1",
    fileArchitecture: "arm64",
  }),
  "darwin-x64": Object.freeze({
    filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-darwin-x64.tar.gz`,
    sha256: "adb8feb2d4987df3d72d2ec46f4fc4b58039c859b8c3f0e3cc2d3c6cbaf8629c",
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
