# gecko.js

Embeddable **Gecko** — Firefox's rendering engine — compiled to WebAssembly, as an
ESM library with a small API class. It lays out and paints real web content into a
`<canvas>` entirely in the browser tab and forwards mouse/keyboard/wheel input.

```ts
import { Gecko } from 'gecko.js';

const gecko = new Gecko({ canvas: document.querySelector('canvas')! });
await gecko.init();
await gecko.load('data:text/html,<h1>hello from Gecko</h1>');
```

## What it ships

The library bundle (`dist/gecko.js`) **inlines** the emscripten glue (`gecko.js`)
and the pthread worker (`gecko.worker.js`) — they run from Blob URLs, so you never
serve them. The only assets you serve are the two large binaries, **`gecko.wasm`**
and **`gecko.data`** (they ship in `dist/`; point libxul at where you serve them
with `assetBase`). Because pthreads need `SharedArrayBuffer`, the page must be
**cross-origin isolated** (`Cross-Origin-Opener-Policy: same-origin` +
`Cross-Origin-Embedder-Policy: require-corp`).

`gecko.data` contains only the **minimal GRE** needed to render a web page. Larger
trees that a basic embed doesn't need — notably the Firefox front-end (`browser/`)
— are left out; supply them yourself with an `fs` provider.

## `GeckoOptions`

| option | meaning |
| --- | --- |
| `canvas` | the page `<canvas>` to paint into (software composited) |
| `env` | extra engine env vars (e.g. `{ GECKO_CHROME: '1' }`) |
| `fs` | `{ readFile, readdir }` supplying GRE files beyond the baked set (mounted under `/gre`) |
| `wispUrl` | WISP websocket endpoint; Necko fetches `http(s)://` over it |
| `assetBase` | URL prefix where you serve `gecko.wasm` + `gecko.data` (default `./`, relative to the page) |
| `tcpTransport` | optional embedder TCP factory (Necko sockets); when set, WISP is unused |
| `onFrame` | optional; called after pixels reach the canvas. Use to invalidate an embedding compositor. GPU reports continue beyond startup only when subscribed; software reports follow the blit. No callbacks after destruction. |
| `onLocationChange` | optional; top-level location changes (`nsIWebProgressListener`) |
| `onContextMenu` | optional; content context-menu payload (engine rolls up XUL first). Unset → XUL menus paint on the canvas |
| `onPopups` | optional; tight BGRA frames for `<select>` / autocomplete (`nsMenuPopupFrame`). Empty array = closed. Unset → canvas overlay |
| `locateFile`, `print`, `printErr`, `width`, `height`, `forwardInput` | as named |

### TCP destinations

The socket bridge supports IPv4 and IPv6 for both `tcpTransport` and WISP.
Transport callbacks receive a hostname or an unbracketed IP literal, plus a
separate port. IPv4-mapped IPv6 addresses normalize to IPv4 at this boundary;
Emscripten's synthetic addresses still resolve back to their original hostname.
Socket address queries retain the original family. Scoped IPv6 destinations
return `EOPNOTSUPP`: neither transport API supports choosing a network interface.

### NSPR IPv6 configuration

NSPR's Emscripten target uses the Linux platform headers, but their IPv6
feature detection requires glibc or Android. Without `_PR_INET6`, NSPR wraps
IPv6 sockets in an IPv6-to-IPv4 layer and rejects non-mapped destinations
with `PR_NETWORK_UNREACHABLE_ERROR` before WasmFS receives `connect()`.
Enable native IPv6 and the available `gethostbyname2` API for this target.
Keep the established synthetic DNS path: Emscripten's `getaddrinfo` rejects
`AI_ADDRCONFIG`, which NSPR always requests.

The patch depends on this wrapper's family-aware WasmFS WISP backend.
`gecko.js/check-nspr-sockets.py` compiles the pinned NSPR sources using the
actual Emscripten `moz.build` declarations and tests both blocking and
nonblocking connections through the production JavaScript bridge. It fails
with the original platform configuration and passes with this patch. CI runs
it and `gecko.js/check-wisp-sockets.sh` before compiling the complete engine.

### The `fs` provider

`readdir(path)` returns child names (directories **suffixed with `/`**); `readFile(path)`
returns the bytes. The provider root maps to `/gre`. See `chrome-demo` for a provider
that serves the Firefox front-end so the full browser UI boots (`GECKO_CHROME=1`).

### Live embedding themes

After `init()`, call `await gecko.setTheme({ contentCss, popupCss, dark })` before
the first `load()` and whenever the host theme changes. `contentCss` is registered
at Gecko's user-agent cascade origin, so ordinary page-authored CSS takes
precedence. It applies to existing and future documents, including frames.
`popupCss` styles the privileged native-select document; it also updates an open
menu. `dark` updates Gecko's system appearance preference. Supply complete
replacement stylesheets on each call; an identical theme is a no-op.

The embedder owns the design tokens and can embed a local font as a data URL.
The UTF-8 JSON payload must be smaller than 65,536 bytes. The theme command runs
in a privileged module, separately from `evalChrome()` (which, despite its old
name, evaluates in the content realm). Native controls and their DOM state are
preserved; theming does not substitute host DOM widgets for page controls.
Optional `selection: { background: '#rrggbb', text: '#rrggbb' }` supplies native
selection system colors, including listboxes whose UA rules intentionally use
`!important`. Omitting it on a later call restores the default selection palette.

## Building

`gecko.*` is produced by `build-lib.sh` (stages the engine libs + a minimal
GRE, then emcc-links), and `dist/` by rspack (`rspack.config.js`). Both run via:

```
make libxul        # from the repo root: builds the engine then the bundle
# or, with the engine already built (obj-full-emscripten/dist/bin/libxul.so):
pnpm --filter gecko.js build
```

### Native input pickers

`onPicker(request, { signal })` supplies embedding UI for Gecko's native file,
color and date/time inputs. Resolve `null` to cancel. Honor the signal so
navigation and `destroy()` close pending dialogs. Requests contain an opaque
`id` and one of:

- `{ kind: "file", title, multiple, filters: [{title, pattern}], filterIndex,
  accept, okLabel }`: return `{ files: [{ name, type, lastModified, base64 }] }`.
  Only send explicitly selected file contents, never host filesystem paths.
  Open and multiple-open modes are supported; folder/save modes are not.
- `{ kind: "color", title, value, colors }`: return `{ value: "#rrggbb" }`.
- `{ kind: "date", type, value, min, max, step, stepBase }`: return `{ value }`
  using HTML's date/time/datetime-local serialization. Empty string clears it.

The embedding uses native picker interfaces and Mozilla's date editor actor,
so content retains native values, validation and trusted form events. The host
must enforce the requested constraints in its picker UI.

Offline fallback fonts are listed in `fonts.json` with source revisions,
SHA-256 digests and license files. `stage-fonts.py` fails a build if any font is
missing or corrupted. The bundle includes full CJK, Arabic, Hebrew, Indic and
Southeast Asian scripts, Georgian, Armenian, Ethiopic, math/symbols and emoji.
