#!/usr/bin/env bash
# Decode a real WAV using only the media plugins shipped in the AppImage.
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: bash $0 path/to/Pharaoh.AppImage [audio-file]" >&2
  exit 1
fi
appimage=$(realpath "$1")
gst_launch=$(command -v gst-launch-1.0)
gst_inspect=$(command -v gst-inspect-1.0)
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT

# Make the fixture using the host before switching to the packaged libraries.
"$gst_launch" -q audiotestsrc num-buffers=8 ! wavenc ! filesink location="$temporary/tone.wav"
(cd "$temporary" && "$appimage" --appimage-extract >/dev/null)
export APPDIR="$temporary/squashfs-root"
test -x "$APPDIR/usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner"
source "$APPDIR/apprun-hooks/linuxdeploy-plugin-gstreamer.sh"
export LD_LIBRARY_PATH="$APPDIR/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export GST_REGISTRY="$temporary/registry.bin"

# Verify the desktop audio sink exists even on headless CI without a sound server.
for plugin in wavparse decodebin audioconvert audioresample autoaudiosink pulsesink; do
  "$gst_inspect" "$plugin" >/dev/null
done
"$gst_launch" -q filesrc location="$temporary/tone.wav" ! decodebin ! audioconvert ! audioresample ! fakesink
if [[ $# == 2 ]]; then
  "$gst_launch" -q filesrc location="$2" ! decodebin ! audioconvert ! audioresample ! fakesink
fi
echo "AppImage media smoke test passed (WAV decoding and audio output plugins)."
