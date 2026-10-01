# Demo recording

`warp.gif` shows `osnova warp` and `osnova plumb` on the pinned click checkout (`benchmarks/click-v1.json`): twelve `grep` hits for `.invoke(` become five confirmed call sites, six name-only matches on other `invoke` methods and one line inside a docstring.

Record it from that checkout with `vhs warp.tape`, which writes frames only (vhs 0.12.0 does not encode), then:

```sh
ffmpeg -framerate 50 -i frames/frame-text-%05d.png -framerate 50 -i frames/frame-cursor-%05d.png \
  -filter_complex "[0][1]overlay=format=auto,pad=iw+96:ih+96:48:48:color=#0D0E0F,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  -r 50 warp.gif
```

Colours follow `assets/brand/README.md`.

## Film

`film.gif` is the getosnova.dev hero film, recorded from the live page. `scripts/record-film.mjs` plays it once in a headless Chromium-family browser and saves every screencast frame with its timestamp:

```sh
node scripts/record-film.mjs https://getosnova.dev/ /tmp/film
```

`/tmp/film/meta.json` holds the film frame's rectangle in CSS pixels; multiply it by the scale (1.84) for the crop. With the defaults the crop is `1940:1091:355:352`. Skip the first half second, which shows the autoplay before the recorder restarts the film:

```sh
ffmpeg -f concat -safe 0 -i /tmp/film/concat.txt -ss 0.5 \
  -vf "crop=1940:1091:355:352,scale=1920:1080:flags=lanczos,fps=30,format=yuv420p" \
  -c:v libx264 -preset slow -crf 18 -tune animation -movflags +faststart -an film-1080p.mp4
ffmpeg -i film-1080p.mp4 \
  -vf "fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" \
  -loop 0 film.gif
```
