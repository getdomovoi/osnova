# getosnova.dev

The marketing site for osnova. Plain HTML, CSS and JavaScript in `public/`, with no build step. It is not part of the npm package.

## Preview

Serve `public/` with any static server, for example:

```sh
npx -y live-server@1.2.2 site/public --port=8788 --no-browser
```

## What the page shows

- The film at the top tells the lede in eight scenes. Every number and output line in it was measured on osnova 0.12.0's own source; the next section records how.
- The install prompts must only use commands the CLI accepts and does what they say. `test/site.test.ts` runs every `osnova setup` command on the page in a temporary home where every agent harness is installed: previews must write nothing, applies must leave nothing to change, and uninstalls must remove every component they installed, except the shared skill that `--only` keeps while another installed harness still reads it.
- `/changelog/`, `/privacy/` and `/security/` are built from `CHANGELOG.md`, `PRIVACY.md` and `SECURITY.md` by `pnpm site:pages`. Edit the Markdown, never the generated HTML; `test/site.test.ts` fails while a page is out of date.
- The npm badge in the header shows the version written into the page, then replaces it with the registry's latest version when the page loads.
- Colours, type and motion follow `assets/brand/README.md`.

## Where the film's numbers come from

Measured on 2026-10-02 with the published 0.12.0 package on a clean export of tag `v0.12.0`. Every directory is fresh. The commands run from a scratch directory, not inside a checkout: there, `npx` runs the checkout's own build, or an `osnova` on `PATH`, instead of downloading the version it names.

```sh
repo=$(pwd)   # the repository root
cd "$(mktemp -d)"
osnova012() { npx -y @getdomovoi/osnova@0.12.0 "$@"; }
osnova012 --version   # must print 0.12.0
src=$(mktemp -d); cache_a=$(mktemp -d); cache_b=$(mktemp -d); out=$(mktemp -d)
git -C "$repo" archive v0.12.0 | tar -x -C "$src"
osnova012 build "$src" --cache-dir "$cache_a"
osnova012 build "$src" --cache-dir "$cache_b"
shasum -a 256 "$cache_a"/*/edges.json "$cache_b"/*/edges.json "$cache_a"/*/text.bin "$cache_b"/*/text.bin
osnova012 warp 'src/api.ts#refreshWorkspace' --workspace "$src" --cache-dir "$cache_a" > "$out/warp_a.txt" 2>&1
osnova012 warp 'src/api.ts#refreshWorkspace' --workspace "$src" --cache-dir "$cache_b" > "$out/warp_b.txt" 2>&1
shasum -a 256 "$out/warp_a.txt" "$out/warp_b.txt"
osnova012 warp 'src/api.ts#refreshWorkspace' --direction out --workspace "$src" --cache-dir "$cache_a"
```

- Read scene: the first build prints `442 files, 7896 symbols, 35343 edges`.
- Weave scene: eleven of the callees the last command lists, each at its calling line in `src/api.ts` (93 to 182). The full answer has 34 indexed edges; the scene says it shows eleven.
- Answer scene: lines copied from `warp_a.txt`.
- Repeat scene: both caches hold the same `edges.json` (`44436d3f275f211e`) and `text.bin` (`2563794a23101811`), and `warp` run against each cache prints the same output (`de1dcc0e1a3ef358`); each value is the first 16 hex digits of SHA-256. `index.json` is left out because it records the absolute path of the indexed folder, so it differs between machines.

## Deploy

The site is a Cloudflare Worker with static assets only. `wrangler.jsonc` names it `getosnova` and binds the custom domain `getosnova.dev`; `public/_headers` sets the content security policy. Wrangler is pinned in `package.json` and `pnpm-lock.yaml` here, a workspace of its own so the pin never enters the osnova package install.

`.github/workflows/site.yml` checks every change that can alter the site and deploys `main` to `getosnova.dev`, using the repository secret `CLOUDFLARE_API_TOKEN`. To deploy by hand:

```sh
pnpm --dir site install --frozen-lockfile
WRANGLER_SEND_METRICS=false pnpm --dir site exec wrangler deploy --dry-run
WRANGLER_SEND_METRICS=false pnpm --dir site exec wrangler deploy
```

The last command publishes the site. It needs a Cloudflare login or token with access to the `getosnova.dev` zone.
