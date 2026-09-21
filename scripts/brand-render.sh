#!/usr/bin/env bash
# Renders assets/brand PNGs from assets/brand/src HTML in headless Chromium.
# Needs network once for Google Fonts (Archivo, IBM Plex Sans, JetBrains Mono).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/assets/brand/src"
out="$root/assets/brand"
browser="${BRAND_BROWSER:-/Applications/Brave Browser.app/Contents/MacOS/Brave Browser}"
[ -x "$browser" ] || { echo "no Chromium at $browser; set BRAND_BROWSER" >&2; exit 1; }

shot() {
  local page="$1" query="$2" w="$3" h="$4" scale="$5" file="$6"
  "$browser" --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=10000 \
    --window-size="$w,$h" --force-device-scale-factor="$scale" \
    --screenshot="$out/$file" "file://$src/$page$query" >/dev/null 2>&1
  echo "$file: $(sips -g pixelWidth -g pixelHeight "$out/$file" | awk '/pixel/ {printf "%s ", $2}')"
}

shot banner.html "" 1200 300 2 banner-dark.png
shot banner.html "?theme=light" 1200 300 2 banner-light.png
shot social-preview.html "" 1200 630 1 social-preview.png
