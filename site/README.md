# getosnova.dev

The marketing site for osnova. Plain HTML, CSS and JavaScript in `public/`, with no build step. It is not part of the npm package.

## Preview

Serve `public/` with any static server, for example:

```sh
npx -y live-server@1.2.2 site/public --port=8788 --no-browser
```

## What the page shows

- The film at the top tells the lede in eight scenes. Every number and output line in it was measured on osnova 0.11.0's own source; the next section records how.
- The install prompts must only use commands the CLI accepts and does what they say. `test/site.test.ts` runs every `osnova setup` command on the page in a temporary home where every agent harness is installed: previews must write nothing, applies must leave nothing to change, and uninstalls must remove every component they installed, except the shared skill that `--only` keeps while another installed harness still reads it.
- `/changelog/`, `/privacy/` and `/security/` are built from `CHANGELOG.md`, `PRIVACY.md` and `SECURITY.md` by `pnpm site:pages`. Edit the Markdown, never the generated HTML; `test/site.test.ts` fails while a page is out of date.
- The npm badge in the header shows the version written into the page, then replaces it with the registry's latest version when the page loads.
- Colours, type and motion follow `assets/brand/README.md`.

## Where the film's numbers come from

Measured on 2026-10-01 with the published 0.11.0 package on a clean export of tag `v0.11.0`. Run from the repository root; every directory is fresh:

```sh
osnova011() { npx -y @getdomovoi/osnova@0.11.0 "$@"; }
src=$(mktemp -d); cache_a=$(mktemp -d); cache_b=$(mktemp -d); out=$(mktemp -d)
git archive v0.11.0 | tar -x -C "$src"
osnova011 build "$src" --cache-dir "$cache_a"
osnova011 build "$src" --cache-dir "$cache_b"
shasum -a 256 "$cache_a"/*/edges.json "$cache_b"/*/edges.json "$cache_a"/*/text.bin "$cache_b"/*/text.bin
osnova011 warp 'src/api.ts#refreshWorkspace' --workspace "$src" --cache-dir "$cache_a" > "$out/warp_a.txt" 2>&1
osnova011 warp 'src/api.ts#refreshWorkspace' --workspace "$src" --cache-dir "$cache_b" > "$out/warp_b.txt" 2>&1
shasum -a 256 "$out/warp_a.txt" "$out/warp_b.txt"
osnova011 warp 'src/api.ts#refreshWorkspace' --direction out --workspace "$src" --cache-dir "$cache_a"
```

- Read scene: the first build prints `397 files, 7069 symbols, 31453 edges`.
- Weave scene: eleven of the callees the last command lists, each at its calling line in `src/api.ts` (93 to 182). The full answer has 34 indexed edges; the scene says it shows eleven.
- Answer scene: lines copied from `warp_a.txt`.
- Repeat scene: both caches hold the same `edges.json` (`aa077378f5db9f52`) and `text.bin` (`35a0907989ddcb04`), and `warp` run against each cache prints the same output (`cfeccec7a316834d`); each value is the first 16 hex digits of SHA-256. `index.json` is left out because it records the absolute path of the indexed folder, so it differs between machines.

## Deploy

The site is a Cloudflare Worker with static assets only. `wrangler.jsonc` names it `getosnova` and binds the custom domain `getosnova.dev`; `public/_headers` sets the content security policy. Wrangler is pinned in `package.json` and `pnpm-lock.yaml` here, a workspace of its own so the pin never enters the osnova package install.

`.github/workflows/site.yml` checks every change that can alter the site and deploys `main` to `getosnova.dev`, using the repository secret `CLOUDFLARE_API_TOKEN`. To deploy by hand:

```sh
pnpm --dir site install --frozen-lockfile
WRANGLER_SEND_METRICS=false pnpm --dir site exec wrangler deploy --dry-run
WRANGLER_SEND_METRICS=false pnpm --dir site exec wrangler deploy
```

The last command publishes the site. It needs a Cloudflare login or token with access to the `getosnova.dev` zone.
