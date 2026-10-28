// Informational Main-channel notice for Stable users. This public, admitted
// snapshot is NOT a verified Stable release and MUST NOT enable an install.
import { EQUINOX_LOCAL_MAIN_REPOSITORY, EQUINOX_LOCAL_MAIN_SNAPSHOT_TAG } from "./equinox-local-main-update.js";
import { validateTrustedMainInstallPointer } from "./equinox-local-main-install-pointer.js";
function recordOrNull(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value : null;
}
const SHA = /^[a-f0-9]{40}$/u;
const TIMEOUT_MS = 5_000;
const MAX_BYTES = 8_192;
const CACHE_MS = 6 * 60 * 60_000;
export function createEquinoxLocalMainChannelNotice({ fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
    let current = Object.freeze({ checkedAt: null, targetSha: null, lastError: null });
    let lastAttempt = -Infinity;
    let pending = null;
    const snapshot = () => current;
    const check = ({ force = false } = {}) => {
        const time = now();
        if (pending)
            return pending;
        if (!force && time.getTime() - lastAttempt < CACHE_MS)
            return Promise.resolve(current);
        lastAttempt = time.getTime();
        pending = (async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
            timer.unref?.();
            try {
                const response = await fetchImpl(`https://api.github.com/repos/${EQUINOX_LOCAL_MAIN_REPOSITORY}/git/ref/tags/${EQUINOX_LOCAL_MAIN_SNAPSHOT_TAG}`, {
                    method: "GET", redirect: "error", cache: "no-store", credentials: "omit",
                    headers: { accept: "application/vnd.github+json", "user-agent": "Equinox-Local" },
                    signal: controller.signal,
                });
                if (!response?.ok || !response.body)
                    throw new Error("Main channel could not be checked.");
                let size = 0;
                const chunks = [];
                for await (const chunk of response.body) {
                    size += chunk.byteLength;
                    if (size > MAX_BYTES)
                        throw new Error("Main channel response exceeded its size limit.");
                    chunks.push(Buffer.from(chunk));
                }
                const json = recordOrNull(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                const object = recordOrNull(json?.object);
                if (json?.ref !== `refs/tags/${EQUINOX_LOCAL_MAIN_SNAPSHOT_TAG}` || object?.type !== "commit" || (typeof object?.sha !== "string" || !SHA.test(object.sha))) {
                    throw new Error("Main channel snapshot identity was invalid.");
                }
                current = Object.freeze({ checkedAt: time.toISOString(), targetSha: object.sha, lastError: null });
            }
            catch {
                // Unknown does not mean up to date. Do not keep a stale 'available' notice.
                current = Object.freeze({ checkedAt: time.toISOString(), targetSha: null, lastError: "Main channel check unavailable." });
            }
            finally {
                clearTimeout(timer);
            }
            return current;
        })().finally(() => { pending = null; });
        return pending;
    };
    return Object.freeze({ snapshot, check });
}
// The managed-main Control Center reads ONLY the production Ed25519-signed
// source-SHA selector. GitHub snapshot/semantic versions are NEVER trusted as
// evidence that a native Main build is downloadable or up to date.
export function createEquinoxLocalSignedMainNativeNotice({ installedSha, target, fetchImpl = globalThis.fetch, verifyPointerImpl = validateTrustedMainInstallPointer, now = () => new Date(), }) {
    if (!SHA.test(installedSha) || !/^(darwin|win32)-(arm64|x64)$/u.test(target)) {
        throw new Error("Signed Main native update discovery requires an exact installed SHA and platform target.");
    }
    let current = Object.freeze({
        checkedAt: null, installedSha, target, targetSha: null, version: null,
        status: "unknown", lastError: null,
    });
    let lastAttempt = -Infinity;
    let pending = null;
    const snapshot = () => current;
    const check = ({ force = false } = {}) => {
        const timestamp = now();
        if (pending)
            return pending;
        if (!force && timestamp.getTime() - lastAttempt < CACHE_MS)
            return Promise.resolve(current);
        lastAttempt = timestamp.getTime();
        pending = (async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
            timer.unref?.();
            try {
                const response = await fetchImpl("https://main.local.sametbasbug.dev/latest/main.json", {
                    method: "GET", redirect: "error", cache: "no-store", credentials: "omit",
                    headers: { accept: "application/json", "user-agent": "Equinox-Local" },
                    signal: controller.signal,
                });
                if (!response?.ok || !response.body)
                    throw new Error("Signed Main selector unavailable.");
                let bytes = 0;
                const chunks = [];
                for await (const chunk of response.body) {
                    bytes += chunk.byteLength;
                    if (bytes > 16 * 1024)
                        throw new Error("Signed Main pointer exceeds its bounded size.");
                    chunks.push(Buffer.from(chunk));
                }
                const signed = verifyPointerImpl(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                const row = signed.targets.find(value => value.target === target);
                if (!row)
                    throw new Error("Signed Main native architecture is not admitted.");
                current = Object.freeze({
                    checkedAt: timestamp.toISOString(), installedSha, target,
                    targetSha: signed.sourceSha, version: signed.version,
                    status: signed.sourceSha === installedSha ? "up_to_date" : "available",
                    lastError: null,
                });
            }
            catch {
                // A failed network/signature/target check must not cache a stale
                // downloadable SHA nor report "up to date" optimistically.
                current = Object.freeze({
                    checkedAt: timestamp.toISOString(), installedSha, target,
                    targetSha: null, version: null, status: "unavailable",
                    lastError: "Production-signed Main native selector unavailable.",
                });
            }
            finally {
                clearTimeout(timer);
            }
            return current;
        })().finally(() => { pending = null; });
        return pending;
    };
    return Object.freeze({ snapshot, check });
}
