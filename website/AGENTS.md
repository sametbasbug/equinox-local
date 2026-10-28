# local.sametbasbug.dev

Public product and policy site for Equinox Local and Equinox Browser.

## Product rules

- Public-facing copy is English unless a specific localization is added deliberately.
- Privacy/security text must match the real Equinox Local and Equinox Browser behavior; never promise stronger guarantees than the code provides.
- No analytics, trackers, remote fonts, ad scripts, or third-party JavaScript.
- Keep the site dependency-light. Astro generates static HTML/CSS with Tailwind CSS; do not ship unnecessary client JavaScript.
- Production is a Cloudflare Worker with static assets on `local.sametbasbug.dev`. The Worker is the origin via a Wrangler Custom Domain, so Cloudflare owns the DNS record and certificate lifecycle.
- This site source now belongs to the canonical public `sametbasbug/equinox-local` repository under `website/`. Cloudflare Workers Builds production and previews now use this public repo’s `main` branch with `website/` as the root directory; verified with a real new-repository build/deployment and live SHA-256 installer/manifest parity on 2026-10-27. The previous GitHub source repository `sametbasbug/equinox-local-site` was deleted on 2026-10-29 after independent Cloudflare build-source and live-site verification. Its complete Git history (including PR refs) is retained only in a locally permission-restricted, ignored recovery bundle. The existing Cloudflare Worker **named** `equinox-local-site` is NOT deleted or replaced; preserve its custom domain. Keep exactly one production Worker and custom domain.
- `src/content/en/privacy.html` generates `/privacy/`, the canonical public Chrome Web Store privacy policy. Keep that public URL stable.
- `site/reviewer/index.html` is reviewer-facing documentation, not a place for secrets or private credentials.
- Security headers are added in `src/index.js`.
- Astro pages live in `src/pages/`, shared UI in `src/components/` and `src/layouts/`, and English/Turkish policy copy in `src/content/`. `site/` holds pass-through release/reviewer assets; `dist/` is generated deployment output. Keep `site/downloads/updates/` and the `release:set-version` command compatible with the Local release factory.
- Cloudflare zone Configuration Rule `Disable Web Analytics on Equinox Local` must remain active for hostname `local.sametbasbug.dev`; it sets **Disable RUM** so Cloudflare does not inject Web Analytics into this no-tracking site.

## Verify

```bash
npm run check
npm run deploy:dry
npm run deploy
```

## Migration owner

See [`../docs/plans/one-main-one-installer-one-repo.md`](../docs/plans/one-main-one-installer-one-repo.md) for the approved, staged migration and its no-private-material rule. Root public `AGENTS.md` also applies.
