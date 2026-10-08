// Informational Main-channel notice for Stable users. This public, admitted
// snapshot is NOT a verified Stable release and MUST NOT enable an install.
import { EQUINOX_LOCAL_MAIN_REPOSITORY, EQUINOX_LOCAL_MAIN_SNAPSHOT_TAG } from "./equinox-local-main-update.js";

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
    if (pending) return pending;
    if (!force && time.getTime() - lastAttempt < CACHE_MS) return Promise.resolve(current);
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
        if (!response?.ok || !response.body) throw new Error("Main channel could not be checked.");
        let size = 0;
        const chunks = [];
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > MAX_BYTES) throw new Error("Main channel response exceeded its size limit.");
          chunks.push(Buffer.from(chunk));
        }
        const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (json?.ref !== `refs/tags/${EQUINOX_LOCAL_MAIN_SNAPSHOT_TAG}` || json.object?.type !== "commit" || !SHA.test(json.object?.sha ?? "")) {
          throw new Error("Main channel snapshot identity was invalid.");
        }
        current = Object.freeze({ checkedAt: time.toISOString(), targetSha: json.object.sha, lastError: null });
      } catch {
        // Unknown does not mean up to date. Do not keep a stale 'available' notice.
        current = Object.freeze({ checkedAt: time.toISOString(), targetSha: null, lastError: "Main channel check unavailable." });
      } finally {
        clearTimeout(timer);
      }
      return current;
    })().finally(() => { pending = null; });
    return pending;
  };
  return Object.freeze({ snapshot, check });
}
