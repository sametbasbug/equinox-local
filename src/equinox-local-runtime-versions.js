export const EQUINOX_LOCAL_NODE_VERSION = "26.8.1";
export const EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION = "0.0.14";
export const EQUINOX_LOCAL_PEEKABOO_VERSION = "4.3.3";
export const EQUINOX_LOCAL_BUNDLED_PEEKABOO_SINCE_VERSION = "4.4.0";
export const EQUINOX_LOCAL_PEEKABOO_TEAM_ID = "FWJYW4S8P8";

export const PEEKABOO_DISTRIBUTION = Object.freeze({
  filename: "peekaboo-macos-universal.tar.gz",
  sha256: "8c9dae67e64459f47653f2d3cd7580e6b593e0d8122da1fbdbc2c8f090748641",
  archiveRoot: "peekaboo-macos-universal",
  architectures: Object.freeze(["arm64", "x86_64"]),
});

export const NODE_DISTRIBUTIONS = Object.freeze({
  "darwin-arm64": Object.freeze({
    filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: "6e577fd0d9db776db82306629e441a9dace416702622aebdd171c9dfaa41f4d2",
    fileArchitecture: "arm64",
  }),
  "darwin-x64": Object.freeze({
    filename: `node-v${EQUINOX_LOCAL_NODE_VERSION}-darwin-x64.tar.gz`,
    sha256: "fe9c6dbf9c8e1b4443803d75e2a20366e420dae650c747dbb116b22975751baf",
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
