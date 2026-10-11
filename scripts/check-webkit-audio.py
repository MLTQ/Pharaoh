"""Exercise the actual audio store through WebKit and Tauri-style asset responses.

Run on a virtual display with the AppImage library/plugin environment enabled.
Only the supplied WAV fixture is served; no general filesystem handler is exposed.
"""
import json
from pathlib import Path
import subprocess
import sys

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
gi.require_version("Soup", "3.0")
from gi.repository import Gio, GLib, Gtk, Soup, WebKit2

repo = Path(__file__).resolve().parents[1]
wave = Path(sys.argv[1]).read_bytes()
store = subprocess.check_output([
    "node", "--input-type=module", "-e",
    "import ts from 'typescript'; import fs from 'node:fs'; "
    "console.log(ts.transpileModule(fs.readFileSync(process.argv[1], 'utf8'), "
    "{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)",
    str(repo / "src/store/audioStore.ts"),
], cwd=repo, text=True)

script = r"""
const report = value => window.webkit.messageHandlers.probe.postMessage(JSON.stringify(value));
let state;
const exports = {};
const require = name => {
  if (name === 'zustand') return {create: init => {
    state = init(update => {state = {...state, ...update}}, () => state);
    return {getState: () => state};
  }};
  if (name === '../lib/transport') return {fileSrc: () => 'asset://localhost/%2Ffixture.wav'};
  if (name === '../lib/errors') return {reportError: (_, error) => report({event:'failed', message:String(error)})};
  throw new Error(`Unexpected module: ${name}`);
};
const ownedURLs = new Set();
const createURL = URL.createObjectURL.bind(URL), revokeURL = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = blob => {const url = createURL(blob); ownedURLs.add(url); return url};
URL.revokeObjectURL = url => {ownedURLs.delete(url); revokeURL(url)};
const NativeAudio = window.Audio;
window.Audio = function(source) {
  const audio = new NativeAudio(source);
  audio.volume = 0;
  audio.addEventListener('playing', () => report({event:'playing', source:audio.currentSrc, duration:audio.duration}));
  audio.addEventListener('ended', () => setTimeout(() => {
    report({event:state.playing === null && ownedURLs.size === 0 ? 'passed' : 'failed', message:'Playback ended; state and Blob cleanup checked'});
  }, 0));
  return audio;
};
""" + store + "\nexports.useAudioStore.getState().play('/fixture.wav');"
html = ("<!doctype html><script>" + script + "</script>").encode()
result = 1


def message(_manager, reply):
    global result
    data = json.loads(reply.get_js_value().to_string())
    print(json.dumps(data), flush=True)
    if data["event"] in ("passed", "failed"):
        result = 0 if data["event"] == "passed" else 1
        Gtk.main_quit()


def serve(request):
    is_audio = request.get_scheme() == "asset"
    body = wave if is_audio else html
    content_type = "audio/x-wav" if is_audio else "text/html"
    status = 200
    headers = Soup.MessageHeaders.new(Soup.MessageHeadersType.RESPONSE)
    headers.append("Access-Control-Allow-Origin", "tauri://localhost")
    requested = request.get_http_headers().get_one("Range")
    if is_audio and requested:
        first, last = requested.removeprefix("bytes=").split("-")
        first, last = int(first), int(last) if last else len(body) - 1
        last = min(last, len(body) - 1)
        headers.append("Content-Range", f"bytes {first}-{last}/{len(body)}")
        headers.append("Accept-Ranges", "bytes")
        headers.append("Access-Control-Expose-Headers", "content-range")
        body = body[first:last + 1]
        status = 206
    headers.append("Content-Type", content_type)
    headers.append("Content-Length", str(len(body)))
    stream = Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(body))
    response = WebKit2.URISchemeResponse.new(stream, len(body))
    response.set_status(status, None)
    response.set_content_type(content_type)
    response.set_http_headers(headers)
    request.finish_with_response(response)


manager = WebKit2.UserContentManager()
manager.register_script_message_handler("probe")
manager.connect("script-message-received::probe", message)
view = WebKit2.WebView(user_content_manager=manager)
view.get_settings().set_media_playback_requires_user_gesture(False)
for scheme in ("asset", "tauri"):
    view.get_context().get_security_manager().register_uri_scheme_as_secure(scheme)
    view.get_context().register_uri_scheme(scheme, serve)
window = Gtk.Window()
window.add(view)
window.show_all()
view.load_uri("tauri://localhost")


def timeout():
    print("WebKit playback test timed out", flush=True)
    Gtk.main_quit()
    return False


GLib.timeout_add_seconds(30, timeout)
Gtk.main()
sys.exit(result)
