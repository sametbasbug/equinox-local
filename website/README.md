> **Migration note (2026-10-27):** This site is now tracked in the canonical public `equinox-local/website/` directory. Cloudflare production now builds this public repository’s `main` branch from `website/` (cutover verified 2026-10-27); the former site repository is rollback-only and must not deploy production. Use `cd website` from the public root for the commands below. See [`../docs/plans/one-main-one-installer-one-repo.md`](../docs/plans/one-main-one-installer-one-repo.md).

# Equinox Local site

The bilingual product, installation, security and privacy website for **Equinox Local**, with a dedicated **Equinox Browser** page and preserved Chrome Web Store reviewer documentation.

Equinox Local’s primary purpose is to connect the agent a user already works with **in ChatGPT on the web** to tools on their Mac. The website leads with that specific use case, not a generic AI harness or a separate local chat application.

Production: https://local.sametbasbug.dev

## Stack

- Astro **7.3.2**, statically generated.
- Tailwind CSS **4.3.3** through the official Vite integration.
- Cloudflare Worker + static assets; existing security headers and download proxy preserved.
- English at `/`, Turkish at `/tr/`, with equivalent localized routes.
- No shipped client-side JavaScript, analytics, trackers, ads, remote fonts or third-party scripts. The mobile menu, FAQ disclosures and illustrative product-preview selector use native HTML/CSS and keyboard-accessible controls.

## Local development

Use Node.js **22.12.0+** and npm **9.6.5+** (Astro's supported floor).

```bash
npm ci
npm run dev
```

The development server is loopback-only, normally at `http://127.0.0.1:4321`. To inspect the production build:

```bash
npm run check
npm run preview
```

`npm run check` builds the site and checks internal paths/fragments, localization/release consistency, the absence of production scripts, canonical privacy requirements, reviewer fixtures and byte-identical pass-through distribution assets.

Astro 7 manages its preview server as a background process. Use `npx astro preview status`, `npx astro preview logs` and `npx astro preview stop` as needed.

## Deployment

```bash
npm run deploy:dry
npm run deploy
```

Both commands build before invoking Wrangler. `deploy:dry` does not publish; `deploy` first runs the integrity checks and then publishes to the existing Worker. Publishing remains subject to maintainer authorization.

## Project structure

```text
src/pages/          Static EN/TR routes and 404
src/layouts/        Shared document, navigation and footer
src/components/     Home, Browser, documentation and illustrative product UI
src/content/en/     English installation and policy copy
src/content/tr/     Turkish installation and policy copy
src/data/           Shared labels, page metadata and release version
src/styles/         Tailwind entry and responsive design system
src/index.js        Existing Worker security headers and release asset proxy
site/               Pass-through assets: downloads, reviewer pages, icon, sitemap
dist/               Generated deploy output (ignored; never edit)
```

The canonical Chrome Web Store policy remains **`https://local.sametbasbug.dev/privacy/`**, sourced from `src/content/en/privacy.html`. The product preview is intentionally labeled illustrative; it does not show private machine state or connect to the viewer's local runtime.

## Release factory compatibility

The Local release factory can continue writing signed manifests/bootstrap metadata to `site/downloads/updates/` and calling:

```bash
npm run release:set-version -- 4.7.0
npm run check
npm run deploy:dry
```

`release:set-version` updates **`src/data/release.json`**, the single source for visible release labels. The next build updates all locales and the preview. Checks require both stable manifests to agree with that version. Installer URLs, reviewer ZIPs, reviewer test text, hashes and the Worker release proxy are unchanged.

`miniflare`'s `sharp` dependency is pinned to **0.35.4** via a narrow override, avoiding the libheif advisory in its upstream 0.35.2 pin without downgrading Wrangler. Revisit the override when Miniflare updates its own dependency.

## Content and design

The redesign uses a warm off-white canvas, ink typography, restrained violet accents and a dark illustrative Control Center. The current product contract includes terminal-first execution, Full/Selected structured access, isolated-default Agent Browser, explicit Your Browser, native per-user macOS and Windows Local apps, macOS-only Desktop permissions, optional send-only Telegram delivery, and signed managed updates. See [content sources](docs/CONTENT_SOURCES.md) for the verified evidence and copy changes.

Cloudflare is configured with an active Configuration Rule named `Disable Web Analytics on Equinox Local`, matching `local.sametbasbug.dev` and setting **Disable RUM**. This prevents Cloudflare Web Analytics from injecting a performance beacon into the site.
