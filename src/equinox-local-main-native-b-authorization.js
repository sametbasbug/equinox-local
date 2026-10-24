import { sign as signEd25519, verify as verifyEd25519 } from "node:crypto";
import { EQUINOX_LOCAL_UPDATE_KEYS } from "./equinox-local-update-keys.js";
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const TARGETS = new Set(["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64"]);
const MAX_BYTES = 1024 * 1024 * 1024;
// Never interpret a Stable manifest signature as authorization to mutate Main B.
export const MAIN_NATIVE_B_SIGNATURE_DOMAIN = "equinox-local-main-native-b-authorization-v2\n";
function object(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new Error(`${label} must be a plain object.`);
    }
    return value;
}
function keys(value, expected, label) {
    const actual = Object.keys(value).sort();
    const want = [...expected].sort();
    if (actual.length !== want.length || actual.some((name, index) => name !== want[index])) {
        throw new Error(`${label} has missing or unexpected properties.`);
    }
}
function digest(value, label) {
    if (typeof value !== "string" || !DIGEST.test(value))
        throw new Error(`${label} must be SHA-256.`);
    return value;
}
function size(value, label, max = MAX_BYTES) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
        throw new Error(`${label} must be a bounded positive integer.`);
    }
    return value;
}
function parsePayload(input) {
    const raw = object(input, "Main B authorization payload");
    keys(raw, ["schemaVersion", "channel", "sourceSha", "target", "runtimeContractSha256", "artifact", "releaseFingerprint"], "Main B authorization payload");
    if (raw.schemaVersion !== 2 || raw.channel !== "main")
        throw new Error("Main B authorization version or channel is invalid.");
    if (typeof raw.sourceSha !== "string" || !SHA.test(raw.sourceSha)) {
        throw new Error("Main B immutable source Git SHA must be exact.");
    }
    if (typeof raw.target !== "string" || !TARGETS.has(raw.target))
        throw new Error("Main B target architecture is invalid.");
    const art = object(raw.artifact, "Main B artifact");
    keys(art, ["sha256", "bytes"], "Main B artifact");
    const tree = object(raw.releaseFingerprint, "Main B native release fingerprint");
    keys(tree, ["sha256", "entries", "bytes"], "Main B native release fingerprint");
    return Object.freeze({
        schemaVersion: 2, channel: "main",
        sourceSha: raw.sourceSha, target: raw.target,
        runtimeContractSha256: digest(raw.runtimeContractSha256, "Main B runtime contract"),
        artifact: Object.freeze({ sha256: digest(art.sha256, "Main B artifact"), bytes: size(art.bytes, "Main B artifact") }),
        releaseFingerprint: Object.freeze({
            sha256: digest(tree.sha256, "Main B native fingerprint"),
            entries: size(tree.entries, "Main B native entry count", 50_000),
            bytes: size(tree.bytes, "Main B native tree bytes", MAX_BYTES),
        }),
    });
}
export function canonicalMainNativeBAuthorizationPayload(raw) {
    return MAIN_NATIVE_B_SIGNATURE_DOMAIN + JSON.stringify(parsePayload(raw));
}
export function createSignedMainNativeBAuthorization(raw, { keyId, privateKey }) {
    if (!KEY_ID.test(keyId))
        throw new Error("Main B signing key ID is invalid.");
    if (privateKey?.asymmetricKeyType !== "ed25519" || privateKey.type !== "private") {
        throw new Error("Main B signer requires a real Ed25519 private key (never embedded in the runtime).");
    }
    const value = parsePayload(raw);
    const signature = signEd25519(null, Buffer.from(canonicalMainNativeBAuthorizationPayload(value), "utf8"), privateKey);
    return Object.freeze({ ...value, signature: Object.freeze({ algorithm: "ed25519", keyId, value: signature.toString("base64") }) });
}
export function validateSignedMainNativeBAuthorization(raw, { publicKeys = EQUINOX_LOCAL_UPDATE_KEYS, expected = {}, } = {}) {
    const value = object(raw, "Signed Main B authorization");
    keys(value, ["schemaVersion", "channel", "sourceSha", "target", "runtimeContractSha256", "artifact", "releaseFingerprint", "signature"], "Signed Main B authorization");
    const { signature: rawSignature, ...payload } = value;
    const verifiedPayload = parsePayload(payload);
    const sig = object(rawSignature, "Main B signature");
    keys(sig, ["algorithm", "keyId", "value"], "Main B signature");
    if (sig.algorithm !== "ed25519" || typeof sig.keyId !== "string" || !KEY_ID.test(sig.keyId) ||
        typeof sig.value !== "string" || sig.value.length !== 88)
        throw new Error("Main B Ed25519 signature metadata is invalid.");
    const publicKey = Object.hasOwn(publicKeys, sig.keyId) ? publicKeys[sig.keyId] : undefined;
    if (typeof publicKey !== "string" || !publicKey.includes("BEGIN PUBLIC KEY")) {
        throw new Error("Main B signing key is not trusted by this build.");
    }
    const signature = Buffer.from(sig.value, "base64");
    if (signature.length !== 64 || signature.toString("base64") !== sig.value) {
        throw new Error("Main B Ed25519 signature is not canonical base64.");
    }
    if (!verifyEd25519(null, Buffer.from(canonicalMainNativeBAuthorizationPayload(verifiedPayload), "utf8"), publicKey, signature)) {
        throw new Error("Main B Ed25519 authorization signature failed.");
    }
    for (const [key, expectedValue] of Object.entries(expected)) {
        if (!Object.hasOwn(verifiedPayload, key) || JSON.stringify(verifiedPayload[key]) !== JSON.stringify(expectedValue)) {
            throw new Error(`Main B signed authorization ${key} differs from the independently expected transaction.`);
        }
    }
    return Object.freeze({ ...verifiedPayload, signature: Object.freeze({ algorithm: "ed25519", keyId: sig.keyId, value: sig.value }) });
}
