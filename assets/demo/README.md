# Demo recording

`warp.gif` shows `osnova warp` and `osnova plumb` on the pinned click checkout (`benchmarks/click-v1.json`): twelve `grep` hits for `.invoke(` become five confirmed call sites, six name-only matches on other `invoke` methods and one line inside a docstring.

Record it from that checkout with `vhs warp.tape`, which writes frames only (vhs 0.12.0 does not encode), then:

```sh
ffmpeg -framerate 50 -i frames/frame-text-%05d.png -framerate 50 -i frames/frame-cursor-%05d.png \
  -filter_complex "[0][1]overlay=format=auto,pad=iw+96:ih+96:48:48:color=#0D0E0F,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  -r 50 warp.gif
```

Colours follow `assets/brand/README.md`.
