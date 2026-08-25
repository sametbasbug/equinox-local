// Public update-signing keys are safe to ship. Private signing keys must never live in this repository.
// Key ids are append-only during rotation so older installed runtimes can continue to verify transition releases.
export const EQUINOX_LOCAL_UPDATE_KEYS = Object.freeze({
  "stable-2026-01": `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAmFYwZkZ7Aabb8QZ/RAwhxr3D4RenekD4Cf2vhs7Vk/A=
-----END PUBLIC KEY-----
`,
});
