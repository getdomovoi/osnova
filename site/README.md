# getosnova.dev

The marketing site for osnova. Plain HTML, CSS and JavaScript in `public/`, with no build step. It is not part of the npm package.

## Preview

Serve `public/` with any static server, for example:

```sh
npx -y live-server@1.2.2 site/public --port=8788 --no-browser
```

## What the page shows

- The film near the top tells the lede in eight scenes. Every number and output line in it comes from osnova 0.11.0 run on its own source: index counts, the callees of `refreshWorkspace`, `osnova warp` lines and the hashes of two fresh builds. Re-measure them before changing the copy.
- The install prompts must only use commands the CLI accepts. `test/site.test.ts` previews every `osnova setup` command on the page against an empty home directory and fails on an unknown subcommand.
- `/changelog/`, `/privacy/` and `/security/` are built from `CHANGELOG.md`, `PRIVACY.md` and `SECURITY.md` by `pnpm site:pages`. Edit the Markdown, never the generated HTML; `test/site.test.ts` fails while a page is out of date.
- The npm badge in the header shows the version written into the page, then replaces it with the registry's latest version when the page loads.
- Colours, type and motion follow `assets/brand/README.md`.

## Deploy

The site is a Cloudflare Worker with static assets only. `wrangler.jsonc` names it `getosnova` and binds the custom domain `getosnova.dev`; `public/_headers` sets the content security policy.

```sh
cd site
WRANGLER_SEND_METRICS=false npx wrangler@latest deploy --dry-run
WRANGLER_SEND_METRICS=false npx wrangler@latest deploy
```

The second command publishes the site. It needs a Cloudflare login with access to the `getosnova.dev` zone.
