# osnova brand assets

Brand identity v1. The source of truth is the brand board "osnova Brand identity v1"; this folder holds what the board exports and what other surfaces are allowed to copy. Use these files as they are.

Tagline: A deterministic code map for AI coding agents.

## Files

| File | Use |
| --- | --- |
| `mark.svg` | Icon, `currentColor`, for anything that sets its own colour |
| `mark-dark.svg` | Icon in ink on dark grounds (`#E8E6E3`), 24 by 24 |
| `mark-light.svg` | Icon in ink on light grounds (`#17181A`), 24 by 24 |
| `diagram-architecture-dark.svg` | Architecture diagram, dark mode, 1600 by 720, transparent |
| `diagram-architecture-light.svg` | Architecture diagram, light mode, 1600 by 720, transparent |
| `diagram-agent-turn-dark.svg` | One agent turn, dark mode, 1600 by 420, transparent |
| `diagram-agent-turn-light.svg` | One agent turn, light mode, 1600 by 420, transparent |
| `banner-dark.png` | README header, dark mode, 1200 by 300 at 2x (2400 by 600) |
| `banner-light.png` | README header, light mode, 1200 by 300 at 2x (2400 by 600) |
| `social-preview.png` | GitHub social preview, 1200 by 630 |
| `src/banner.html` | Source of both banners (board section 07); `?theme=light` selects the light variant |
| `src/social-preview.html` | Source of the social preview (board section 06) |

## Mark

Three warp threads of unequal length, tied by one weft and anchored in a plinth. Foundation and weave in five rectangles. No curves, no counters, no detail that disappears below 16 px.

Geometry: a 24 unit grid, `viewBox="0 0 24 24"`, five rectangles, every corner `rx="0.4"`, fill `currentColor`.

| Rectangle | x | y | width | height |
| --- | --- | --- | --- | --- |
| Warp thread, left | 4.4 | 2.6 | 3.1 | 17.9 |
| Warp thread, middle | 10.45 | 5.6 | 3.1 | 14.9 |
| Warp thread, right | 16.5 | 4.1 | 3.1 | 16.4 |
| Weft | 1.6 | 10.9 | 20.8 | 2.6 |
| Plinth | 1.6 | 17.4 | 20.8 | 3.1 |

Sizes it is drawn for: 16, 24, 32 and 48 px (favicon, npm avatar, rail, docs).

Clearspace is one warp width, 3.1 grid units, on every side. Minimum size is 16 px; below that use the plinth and weft only. Never re-colour individual threads, never rotate, never outline. Flat fills only: no gradient in the mark, the banner or any badge.

## Colour

One primary, warp brass, for the mark and anything the tool asserts. One accent, ground slate, for structure and links in docs. Everything else is neutral. Contrast is stated against the ground it sits on, both modes at or above 4.5:1. Dark is the default; light is the same contract inverted.

| Role | Dark | Contrast on bg `#0D0E0F` | Light | Contrast on paper `#F5F3EF` |
| --- | --- | --- | --- | --- |
| Background | `#0D0E0F` | | `#F5F3EF` | |
| Surface | `#141517` | | `#FFFFFF` | |
| Line | `#232528` | | `#DEDAD2` | |
| Ink | `#E8E6E3` | 15.7:1 | `#17181A` | 16.2:1 |
| Ink muted | `#9A9894` | 6.8:1 | `#5C5A56` | 6.2:1 |
| Warp brass, primary | `#C89B4A` | 7.6:1 | `#8A5F16` | 5.1:1 |
| Ground slate, accent | `#6FA3A8` | 6.9:1 | `#2E5F66` | 6.4:1 |

Slate is structure and links. Brass is the tool asserting something. Tints are `color-mix()` against the ground, never a baked alpha.

## Type

| Role | Face | Weight and size |
| --- | --- | --- |
| Headings | Archivo (OFL) | 600, tracking -0.025em at display; 500, tracking -0.01em below 24 px |
| Body | IBM Plex Sans (OFL) | 400, 500 for emphasis; 15 px at 1.65 in docs |
| Machine | JetBrains Mono (OFL) | paths, commands, shas, symbol names, tool names |

Font stacks used in the SVGs: `Archivo, 'IBM Plex Sans', Helvetica, Arial, sans-serif` for labels and captions; `'JetBrains Mono', 'IBM Plex Mono', Menlo, Consolas, monospace` for anything typed.

## Wordmark

Always `osnova`, lowercase. Never capitalised, never spaced out. Set in Archivo 600 with tracking -0.025em at display size and -0.01em below 24 px. The lockup at 24 px is the README header size.

## Diagram style

Boxes on a single rule, mono labels, one brass thread marking where osnova speaks. Every diagram follows five rules:

1. 1 px lines.
2. No arrowheads heavier than 6 px.
3. No fills except the brass tick.
4. Sentence-case captions.
5. Mono for anything typed.

A brass rule means osnova answered from the index. A grey rule means the agent or the developer acted.

## The ten tools

Every name comes from the one image: ground you stand on, thread you follow, warp that holds the weave, plumb line dropped through it. Names are lowercase mono in every surface, because they are typed.

| Name | What | Why |
| --- | --- | --- |
| `ground` | Keyword search | the ground you stand on |
| `thread` | Text search | the thread you follow through the cloth |
| `outline` | One file's signatures | the outline of one part |
| `warp` | Call graph | the threads that hold the weave |
| `groundwork` | Repository map | the groundwork under everything |
| `footing` | Task context | the footing you build on |
| `settle` | Change impact | how the ground settles after a change |
| `plumb` | Path between two symbols | the plumb line dropped straight through |
| `tests` | Tests that reach a symbol | the cloth pulled to see what holds |
| `unreferenced` | Symbols nothing calls | threads left loose at the edge |

## Voice check

Not this: "AI-native code intelligence that understands your entire codebase".

This: "A symbol and call graph, built from the repository you point it at. Same commit, same answer. It does not read code it was not given, and it tells you when a symbol is outside the index."

## Rendering

The PNGs render from `src/*.html` in headless Chromium with Google Fonts:

```
bash scripts/brand-render.sh
```

It writes `banner-dark.png` and `banner-light.png` at 2x and `social-preview.png` at 1x. It needs network once for the fonts and a Chromium at `BRAND_BROWSER` (default: Brave on macOS). Re-render when copy changes; do not edit the PNGs by hand.

The SVGs are hand-written from the board and carry no embedded fonts; they fall back through the stacks above on machines without Archivo, IBM Plex Sans or JetBrains Mono. Each diagram has a transparent background and is drawn for its own ground: the dark file for a near-black page, the light file for a white page. Serve them with `<picture>` and `prefers-color-scheme`; GitHub renders one file on both themes otherwise.
