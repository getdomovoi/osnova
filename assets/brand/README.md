# Osnova brand assets

Source of truth for the mark, banners and social preview. Use these files as they are. Do not recolor threads, rotate, outline or add a gradient.

## Files

| File | Use |
| --- | --- |
| `mark.svg` | Icon, `currentColor`, for anything that sets its own color |
| `mark-dark.svg` | Icon in ink on dark grounds (`#E8E6E1`) |
| `mark-light.svg` | Icon in ink on light grounds (`#1A1B19`) |
| `banner-dark.png` | README header, dark mode, 2400 by 360 (2x) |
| `banner-light.png` | README header, light mode, 2400 by 360 (2x) |
| `social-preview.png` | GitHub social preview, 1200 by 630 |

The mark is three warp threads of unequal height, one weft across them, one ground bar under. Grid 32, threads 3 wide, weft 1.5, ground 4. Minimum size 16 px.

## Color

| Role | Dark | Light |
| --- | --- | --- |
| Background | `#111210` | `#F6F5F1` |
| Surface | `#1A1B19` | `#FFFFFF` |
| Line | `#2C2E2B` | `#D9D7D0` |
| Ink | `#E8E6E1` | `#1A1B19` |
| Muted | `#9A9990` | `#5C5D57` |
| Primary, warp blue | `#8FB3D3` | `#2F5A7C` |
| Accent, survey orange | `#E08A3C` | `#A84E14` |

Blue is the query: links, tool names, active state. Orange is the change: used once per view, only for what moved or needs attention. Every pair above passes 4.5:1 as body text on its background.

## Type

Headings: Instrument Sans 600, lowercase wordmark, tracking -0.035em. Body: IBM Plex Sans 400, 16 px at 1.65. Code and tool names: IBM Plex Mono, always lowercase, always blue. All three are OFL.

## Wordmark

Always `osnova`, lowercase. Never capitalized, never spaced out. Lockup gap is three thread widths.

## Rendering

The PNGs render from HTML with Google Fonts in a headless Chromium at the stated sizes. Re-render when copy changes; do not edit the PNGs by hand.
