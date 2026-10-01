# getosnova.dev

The marketing site for osnova. Plain HTML, CSS and JavaScript in `public/`, with no build step. It is not part of the npm package.

## Preview

Serve `public/` with any static server, for example:

```sh
npx -y live-server@1.2.2 site/public --port=8788 --no-browser
```

## What the page shows

- The film at the top tells the lede in eight scenes. Every number and output line in it was measured on osnova 0.11.0's own source; the next section records how.
- The install prompts must only use commands the CLI accepts and does what they say. `test/site.test.ts` runs every `osnova setup` command on the page in a temporary home where every agent harness is installed: previews must write nothing, applies must leave nothing to change, and uninstalls must remove what they installed.
- `/changelog/`, `/privacy/` and `/security/` are built from `CHANGELOG.md`, `PRIVACY.md` and `SECURITY.md` by `pnpm site:pages`. Edit the Markdown, never the generated HTML; `test/site.test.ts` fails while a page is out of date.
- The npm badge in the header shows the version written into the page, then replaces it with the registry's latest version when the page loads.
- Colours, type and motion follow `assets/brand/README.md`.

## Where the film's numbers come from

Measured on 2026-09-30 from a clean export of tag `v0.11.0`, indexed into a scratch cache:

```sh
git archive v0.11.0 | tar -x -C /tmp/v011
osnova build /tmp/v011 --cache-dir /tmp/v011-cache
osnova warp 'src/api.ts#refreshWorkspace' --workspace /tmp/v011 --cache-dir /tmp/v011-cache
osnova warp 'src/api.ts#refreshWorkspace' --direction out --workspace /tmp/v011 --cache-dir /tmp/v011-cache
```

- Read scene: `built index ...: 397 files, 7069 symbols, 31453 edges`.
- Weave scene: eleven of the callees `--direction out` lists, each at its calling line in `src/api.ts` (93 to 182). The full answer has 34 indexed edges; the scene says it shows eleven.
- Answer scene: lines copied from the first `osnova warp` output.
- Repeat scene: a second `osnova build` into another empty cache gave byte-identical `index.json` (`2bd883c1241f61a7`) and `edges.json` (`aa077378f5db9f52`), and two runs of the first `warp` command gave the same output (`cfeccec7a316834d`); each is the first 16 hex digits of SHA-256.

## Deploy

The site is a Cloudflare Worker with static assets only. `wrangler.jsonc` names it `getosnova` and binds the custom domain `getosnova.dev`; `public/_headers` sets the content security policy. Wrangler is pinned in `package.json` and `pnpm-lock.yaml` here, a workspace of its own so the pin never enters the osnova package install.

`.github/workflows/site.yml` checks every change that can alter the site and deploys `main` to `getosnova.dev`, using the repository secret `CLOUDFLARE_API_TOKEN`. To deploy by hand:

```sh
pnpm --dir site install --frozen-lockfile
WRANGLER_SEND_METRICS=false pnpm --dir site exec wrangler deploy --dry-run
WRANGLER_SEND_METRICS=false pnpm --dir site exec wrangler deploy
```

The last command publishes the site. It needs a Cloudflare login or token with access to the `getosnova.dev` zone.
