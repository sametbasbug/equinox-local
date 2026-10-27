# Website content sources

Reviewed: **2026-09-09**, against the released **Equinox Local 4.7.0** product source and public-template documentation. This is a content review record, not a change to the product's permissions or release policy.

## Evidence and changes

| Subject | Verified source in the product repository | Website treatment |
| --- | --- | --- |
| Current release | `factory/local/public-template/CHANGELOG.md`; site ARM64 and x64 stable manifests | One release label source in `src/data/release.json`; build checks channel agreement |
| Terminal-first work | Public-template README, security model; `src/equinox-control-center.js` Agent Access text | Replaced the obsolete “no general shell” and file/Git wrapper narrative |
| Full / Selected | Public-template security model and current Control Center source | Fresh installs start Full; Selected applies to root-aware structured capabilities, not running shells |
| Managed processes | Public-template README and 4.7.0 changelog | Unfinished commands continue as the same process; do not claim process ownership is a sandbox |
| Browser contexts | Public-template README, `docs/browser.md`, security model | Agent Browser is the isolated default; Your Browser is an explicit personal context; no silent fallback |
| Browser consent and data | Existing canonical policy, Browser docs and security model | Per-profile Store installation and consent; personal bookmarks not automated; preserve Chrome Web Store Limited Use text |
| Native app | Public-template README, current product boundaries and changelog | Installation opens Equinox Local.app; desktop permissions use its stable identity |
| Tunnel connection | Public-template `docs/tunnel.md` and README | Separate Tunnel ID and restricted runtime key; outbound connection; OpenAI plan/workspace requirements are not promised universally |
| Telegram | Public-template README and current product boundaries | Optional one-private-user, send-only delivery; no inbox or agent-selected recipient |
| Updates | Public-template `docs/updates.md`, security model and shipped bootstrap | Distinguish initial HTTPS size/hash verification from Ed25519-signed managed updates and rollback |
| Data destinations | Public-template security model, README and existing privacy policy | Local-first is not offline-only; connected AI/providers may receive task data |

The current released changelog and implementation take precedence over older productization notes that still describe previous release numbers or the retired browser arrangement. The product repository is read-only for this website redesign.

## Product positioning

The maintainer’s 2026-09-09 review clarified the core promise: **bring the agent running in ChatGPT on the web to the user’s Mac**, rather than present Local as a generic agent harness. The public-template README already identifies ChatGPT on the web as the intended use case. Hero, metadata, footer, capability introductions, setup and closing copy now name that context explicitly in both languages. The agent/conversation remains in ChatGPT; Local supplies the Mac-side tools and controls. This messaging change does not narrow the factual privacy policy’s coverage of connected providers.

## Routes

Both English and Turkish include home, installation, Browser, security, privacy and contact pages. The English privacy URL is unchanged. Existing `/reviewer/`, `/reviewer/test/`, `/reviewer/test/success/`, reviewer packages, update metadata and the installer are pass-through assets, not rewritten product pages.

## Visual representation

The Control Center preview is an HTML/CSS illustration based on current product terminology and capabilities, with generic example states. It is labeled as illustrative in both languages and never presents itself as the visitor's live setup or a captured private machine. Radio controls and FAQ disclosures work without JavaScript; reduced-motion preferences are respected.

No usage metrics, testimonials, customer logos, benchmarks, pricing claims or unsupported compatibility promises have been invented.
