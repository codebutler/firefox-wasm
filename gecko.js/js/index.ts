// gecko.js — embeddable Gecko (the Firefox engine) compiled to WebAssembly.
//
// `new Gecko({ canvas })`, `await g.init()`, `await g.load(url)`. The engine runs
// on a pthread; the page <canvas> receives software-composited frames and forwards
// mouse/keyboard/wheel input. GRE resources are split: the minimal set needed to
// render a web page is baked into gecko.data; anything else (chrome UI, etc.) is
// supplied by the consumer through an `fs` provider (readFile/readdir).

// gecko.js (emscripten glue) is inlined into this bundle as a source string and run
// from a Blob URL, so consumers never serve it; gecko.data is inlined too, so the ONLY
// artifact the consumer serves is the wasm (GeckoOptions.wasm). emscripten 6.0.x no longer emits a separate
// *.worker.js; pthread workers spawn from the main module via mainScriptUrlOrBlob.
import geckoSource from '../wasm/gecko.js?source';
import { ZSTDDecoder } from 'zstddec';
// gecko.data is baked into this bundle, zstd-compressed (decoded at load with
// zstddec), so consumers serve only the wasm. gecko-assets.json (also inlined) says
// whether the wasm is compressed (RELEASE builds) and its uncompressed size.
import geckoDataZst from '../wasm/gecko.data.zst?inline';
import assets from '../wasm/gecko-assets.json';

// ---- public API -----------------------------------------------------------

/** File/directory metadata returned by a provider's `stat` (null = does not exist). */
export interface FsStat {
  size: number;
  isDir: boolean;
  /** Modification time in ms since epoch (optional). */
  mtime?: number;
}

/**
 * Async fallback storage for GRE files that are NOT baked into the shipped
 * gecko.data, mounted under GRE_DIR (/gre). When Gecko opens a /gre path that isn't
 * already present, the engine resolves it through this provider; paths passed here
 * are RELATIVE to the mount root (e.g. "modules/Foo.sys.mjs"). Back it with
 * IndexedDB, OPFS, fetch, … — all methods are genuinely async (the engine's
 * synchronous read blocks a Gecko worker thread, never the page main thread).
 */
export interface FsProvider {
  stat(path: string): Promise<FsStat | null>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<Uint8Array>;
}

/**
 * Read-write async storage for the persistent profile, a separate mount (/profile).
 * The engine opens a profile file -> the whole file is fetched here on demand (async);
 * writes accumulate in memory and are flushed back here per-file on fsync/close
 * (`writeFile` with the full contents). Defaults to OPFS; override with your own
 * backend, or pass a string path to use OPFS rooted there. Paths are mount-relative.
 */
export interface ProfileProvider extends FsProvider {
  writeFile(path: string, data: Uint8Array): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** Move from -> to (Gecko writes prefs/sessionstore as temp-then-rename). */
  rename(from: string, to: string): Promise<void>;
}

// OPFS subdir for the default profile when `profile` is not supplied.
const DEFAULT_PROFILE_PATH = 'gecko-profile';

// Mount IDs handed to the WasmFS ProviderBackend; index into Module.geckoProviders.
// The provider receives MOUNT-RELATIVE paths (the backend accumulates from its root),
// so no path adaptation is needed (unlike the old absolute-path fs-provider.js).
const PROFILE_MOUNT = 1;
const GRE_MOUNT = 0;

// A string `fs`/`profile` path is served by WasmFS's NATIVE OPFS backend (mounted
// at /opfs in xul_init): ranged sync-access-handle I/O on a dedicated worker, no
// round-trip to the page main thread -- the fast path. `/opfs/<path>` maps to the
// OPFS directory at <path>. A custom FsProvider/ProfileProvider OBJECT instead uses
// the proxy-to-R ProviderBackend (the only way to drive arbitrary consumer JS).
const opfsAbs = (p: string) => '/opfs/' + p.replace(/^\/+|\/+$/g, '');

/** Optional embedder TCP transport — see Module.tcpTransport in wisp-net.js. */
export type TcpTransportFactory = (
  host: string,
  port: number,
  handlers: {
    onData: (chunk: Uint8Array) => void;
    onConnected: () => void;
    onEof: () => void;
    onError: (code?: number) => void;
  },
) => { send: (chunk: Uint8Array) => void; close: () => void };

export interface GeckoContextMenuInfo {
  x: number;
  y: number;
  pageUrl?: string;
  canBack?: boolean;
  canForward?: boolean;
  flags?: {
    link?: boolean;
    image?: boolean;
    media?: boolean;
    selection?: boolean;
    editable?: boolean;
  };
  linkUrl?: string;
  linkText?: string;
  imageUrl?: string;
  imageAlt?: string;
  mediaUrl?: string;
  selectionText?: string;
}

/** Tight BGRA popup from paint_popup_windows (host-owned copy, not a HEAP view). */
export interface GeckoPopup {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  pixels: Uint8Array;
}

export interface GeckoOptions {
  /**
   * The page canvas the engine composites into. In software mode it receives
   * BGRA frames blitted via a 2D context. In GPU mode (env.GECKO_GPU set) the
   * engine instead creates a WebGL2 context on it directly — it must be free of
   * any other context and is forced to id="screen" (the engine's hardcoded GL
   * target selector); WebRender presents through an overlaid #glout canvas.
   */
  canvas: HTMLCanvasElement;
  width?: number;
  height?: number;
  /** Extra engine env vars (e.g. MOZ_LOG, GECKO_WASMJIT, GECKO_STYLO_THREADS). */
  env?: Record<string, string>;
  /** WISP websocket endpoint; Necko fetches http(s):// over it. */
  wispUrl?: string;
  /**
   * Optional TCP transport factory. When set, Necko sockets route through it
   * instead of the WISP WebSocket (`Module.wispUrl` is unused). Signature:
   *   connect(host, port, { onData, onConnected, onEof, onError }) → { send, close }
   * Return the handle synchronously; fire `onConnected` when the duplex is
   * ready (may be async). Generic embedder API — see gecko.js/lib/wisp-net.js.
   */
  tcpTransport?: TcpTransportFactory;
  /**
   * Optional: called on top-level location changes (nsIWebProgressListener).
   * When set, an embedder can drop its evalChrome location poller. Absent on
   * discs built before this callback existed — poller remains the fallback.
   */
  onLocationChange?: (url: string) => void;
  /**
   * Optional: called when content would show a context menu (right-click /
   * ContextMenu key). The engine rolls up any XUL popup first. Unset → the
   * engine paints XUL menus onto the canvas (standalone demo).
   */
  onContextMenu?: (info: GeckoContextMenuInfo) => void;
  /**
   * Optional: called each time visible nsMenuPopupFrame popups are painted
   * (`<select>`, autocomplete). Each entry is a tight BGRA buffer at widget
   * bounds. Empty array = all closed. Unset → popups composite onto the
   * canvas overlay (standalone demo).
   */
  onPopups?: (popups: GeckoPopup[]) => void;
  /**
   * Async fallback for GRE files beyond the baked-in minimal set (mounted at /gre).
   * Either an FsProvider, or a string OPFS path (-> a built-in OPFS-backed provider
   * rooted there). Omit for baked-only.
   */
  fs?: FsProvider | string;
  /**
   * Persistent profile storage (separate mount at /profile, read-write). Either a
   * ProfileProvider, or a string OPFS path. Omitted -> a default OPFS provider at
   * "gecko-profile". (Falls back to ephemeral in-memory if OPFS is unavailable.)
   */
  profile?: ProfileProvider | string;
  /**
   * The served engine wasm — REQUIRED, no default. `url` is where the consumer serves it
   * (`gecko.wasm`, or `gecko.wasm.zst` if zstd-compressed); set `compressed: true` for the
   * `.zst` (the loader decodes it in-browser). The glue + gecko.data are inlined into this
   * bundle, so the wasm is the ONLY artifact you serve. e.g. `{ url: '/gecko.wasm' }` or
   * `{ url: '/gecko.wasm.zst', compressed: true }`.
   */
  wasm: { url: string; compressed?: boolean };
  /** Advanced: override emscripten's file locator (rarely needed; the wasm comes from `wasm.url`). */
  locateFile?: (file: string) => string;
  print?: (s: string) => void;
  printErr?: (s: string) => void;
  /** Forward mouse/keyboard/wheel from the canvas to the engine (default true). */
  forwardInput?: boolean;
}

// ---- command struct (mirror embed-xul.cpp XulCmd) -------------------------
// state@0 w@4 h@8 result(ptr)@12 len@16 url@20[8192], then input fields after url.
const ST = 0, W = 4, H = 8, RES = 12, LEN = 16, URLOFF = 20;
const OP = URLOFF + 8192,
  EVTYPE = OP + 4, EX = OP + 8, EY = OP + 12, BTN = OP + 16, BTNS = OP + 20,
  CLICKS = OP + 24, MODS = OP + 28, KEYCODE = OP + 32, CHARCODE = OP + 36,
  DX = OP + 40, DY = OP + 44, KEYVAL = OP + 48, CURSOR = KEYVAL + 64;

const OP_LOAD = 0, OP_MOUSE = 1, OP_KEY = 2, OP_WHEEL = 3, OP_PAINT = 4, OP_EVAL = 5;
const OP_CLIP_SET = 9, OP_ROLLUP = 10;
const MOD_ALT = 0x1, MOD_CTRL = 0x2, MOD_SHIFT = 0x4, MOD_META = 0x8;

// StyleCursorKind index -> CSS cursor keyword (ServoStyleConsts.h order).
const CURSORS = ['none', 'default', 'pointer', 'context-menu', 'help', 'progress',
  'wait', 'cell', 'crosshair', 'text', 'vertical-text', 'alias', 'copy', 'move',
  'no-drop', 'not-allowed', 'grab', 'grabbing', 'e-resize', 'n-resize', 'ne-resize',
  'nw-resize', 's-resize', 'se-resize', 'sw-resize', 'w-resize', 'ew-resize',
  'ns-resize', 'nesw-resize', 'nwse-resize', 'col-resize', 'row-resize',
  'all-scroll', 'zoom-in', 'zoom-out', 'auto'];

interface GeckoModule {
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  ENV: Record<string, string>;
  FS: any;
  /**
   * emscripten's selector->element override map (library_html5.js), consulted by
   * findEventTarget/findCanvasEventTarget BEFORE document.querySelector. Exported
   * via -sEXPORTED_RUNTIME_METHODS in build-lib.sh; optional here so a bundle built
   * against an older link (without the export) degrades to a clear warning instead
   * of a TypeError.
   */
  specialHTMLTargets?: Record<string, HTMLElement>;
  _xul_cmd_ptr(): number;
  addRunDependency(id: string): void;
  removeRunDependency(id: string): void;
}
type GeckoFactory = (opts: Record<string, unknown>) => Promise<GeckoModule>;

// The engine glue is a classic emscripten MODULARIZE build (EXPORT_ES6 + pthread is
// unreliable in this emsdk). Both it and the pthread worker are inlined as source
// (asset/source) and run from Blob URLs, so nothing has to be served for them.
const toBlobUrl = (src: string) => URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
let _geckoUrl: string | undefined;
const geckoBlobUrl = () => (_geckoUrl ??= toBlobUrl(geckoSource));

let _engine: Promise<GeckoFactory> | undefined;
function loadEngine(): Promise<GeckoFactory> {
  return (_engine ??= new Promise<GeckoFactory>((resolve, reject) => {
    const have = (globalThis as Record<string, unknown>).createGecko as GeckoFactory | undefined;
    if (have) return resolve(have);
    const s = document.createElement('script');
    s.src = geckoBlobUrl(); s.async = true;
    s.onload = () => {
      const f = (globalThis as Record<string, unknown>).createGecko as GeckoFactory | undefined;
      f ? resolve(f) : reject(new Error('gecko.js: engine evaluated but createGecko is missing'));
    };
    s.onerror = () => reject(new Error('gecko.js: failed to evaluate the bundled engine'));
    document.head.appendChild(s);
  }));
}

interface Cmd {
  op: number; evType?: number; x?: number; y?: number; button?: number;
  buttons?: number; clickCount?: number; modifiers?: number; keyCode?: number;
  charCode?: number; deltaX?: number; deltaY?: number; key?: string; url?: string;
  resolve?: (v: number | string | null) => void;
}

export class Gecko {
  private opts: GeckoOptions;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private gpu = false;
  private W: number;
  private H: number;
  private mod: GeckoModule | null = null;
  private cmd = 0;
  private queue: Cmd[] = [];
  private running = false;
  private painting = false;
  private enc = new TextEncoder();
  private dec = new TextDecoder();
  private blitImg: ImageData | null = null;
  private blitDst32: Uint32Array | null = null;
  // GPU mode: the engine keeps popups (menus, context menus, panels, <select>
  // dropdowns) off the WebGL compositor and paints them into a separate BGRA
  // buffer; we draw that onto a 2D canvas stacked above #glout. (Software mode
  // composites popups into the main buffer, so this is GPU-only.)
  private popupCtx: CanvasRenderingContext2D | null = null;
  // The overlay element itself, held by reference rather than re-found with
  // document.getElementById: the embedder's canvas may live in a SHADOW ROOT (the
  // overlay is created as its sibling, so a document-level lookup can't see it), and
  // a document-wide id is not per-instance -- two Gecko instances on one page would
  // both resolve to whichever overlay was created first.
  private popupCanvas: HTMLCanvasElement | null = null;
  private popupImg: ImageData | null = null;
  private popupDst32: Uint32Array | null = null;
  private popupShown = false;
  private hostPopups = false;
  private lastPtr = { x: 0, y: 0 };
  private detach: Array<() => void> = [];
  /**
   * Resolves when the engine's FIRST frame has actually reached the canvas.
   *
   * `load()` resolving only means the DOCUMENT finished loading; in GPU mode the
   * compositor presents autonomously off the refresh driver, so pixels can arrive
   * seconds later (RenderThread's device init is slow under software GL). An
   * embedder that uncovers its surface when load() resolves therefore shows a blank
   * window for that whole gap. Await this instead:
   *
   *   await gecko.load(url);
   *   await gecko.firstPaint;   // now there is something to look at
   *
   * Signalled once per instance from gl_present_yield (lib/gl-present.js), the only
   * place that observes the present. It stays resolved afterwards, so awaiting it on
   * every load is fine. SOFTWARE mode has no such gap -- the paint loop pulls and
   * blits each frame itself -- so there it resolves as soon as the engine is up.
   */
  readonly firstPaint: Promise<void>;
  private resolveFirstPaint!: () => void;

  /**
   * firstPaint needs BOTH of these, because measurement says each alone is wrong:
   *
   *  - `loadSettled` -- the first load() has returned, so a present can carry
   *    this document rather than whatever preceded it.
   *  - present index >= 2 -- the compositor's OPENING present is a device-init
   *    frame that never carries content.
   *
   * Two software-GL traces, with the load landing on opposite sides of present #1:
   *   A: present #1 t=27.6s, load stop t=27.8s, present #2 t=29.3s
   *   B: load stop t=24.2s, present #1 t=27.5s, present #2 t=29.8s
   * Resolving on "first present" alone was blank in A; on "first present after
   * the load" alone it was blank in B (that present is #1). Only the conjunction
   * is right in both. The `>= 2` is empirical, not derived -- gecko exposes no
   * first-contentful-paint to the embedder, so this is the honest approximation.
   */
  private loadSettled = false;

  private onPresent(n: number): void {
    if (this.opts.env?.GECKO_PRESENT_DEBUG) {
      (this.opts.printErr ?? ((s: string) => console.warn(s)))(
        `present #${n}${this.loadSettled ? ' (load settled)' : ' (pre-load)'}`);
    }
    // PRESENT_REPORT_CAP -- MUST stay in sync with lib/gl-present.js, which stops
    // reporting there. Resolving at the cap means a pathologically long first
    // load degrades to "uncover anyway" instead of leaving firstPaint pending
    // forever, which would wedge an embedder that waits on it.
    if ((this.loadSettled && n >= 2) || n >= 600) this.resolveFirstPaint();
  }

  constructor(opts: GeckoOptions) {
    this.firstPaint = new Promise<void>((r) => (this.resolveFirstPaint = r));
    this.opts = opts;
    this.hostPopups = typeof opts.onPopups === 'function';
    this.canvas = opts.canvas;
    this.W = opts.width ?? this.canvas.width ?? 800;
    this.H = opts.height ?? this.canvas.height ?? 600;
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.gpu = !!this.opts.env?.GECKO_GPU;
    if (this.gpu) {
      // GPU mode: the engine creates a WebGL2 compositor context on this canvas
      // (selector "#screen", hardcoded in GLContextProviderEmscripten) and presents
      // through a #glout overlay. A canvas can hold only one context type, so the
      // page must NOT grab a 2D context here (doing so makes the engine's
      // emscripten_webgl_create_context("#screen") fail -> WebRenderAPI::Create
      // dereferences a null GL context and traps). There's no software blit.
      if (this.canvas.id !== 'screen') this.canvas.id = 'screen';
    } else {
      const ctx = this.canvas.getContext('2d');
      if (!ctx) throw new Error('gecko.js: canvas already has a non-2d context');
      this.ctx = ctx;
    }
  }

  /** Instantiate the engine, mount GRE files, and wait until it is ready. */
  async init(): Promise<void> {
    if (this.gpu) this.setupGpuPresent();
    const print = this.opts.print ?? ((s) => console.log(s));
    const printErr = this.opts.printErr ?? ((s) => console.warn(s));

    if (!this.opts.wasm?.url) {
      throw new Error(
        "gecko.js: the `wasm` option is required — set it to where you serve the engine wasm, " +
        "e.g. { url: '/gecko.wasm' } (or { url: '/gecko.wasm.zst', compressed: true }).");
    }
    const wasmUrl = this.opts.wasm.url;
    const wasmCompressed = this.opts.wasm.compressed ?? false;

    const createGecko = await loadEngine();

    let resolveReady!: () => void;
    const ready = new Promise<void>((r) => (resolveReady = r));

    // Resolve the FS providers (awaiting OPFS root handles) before startup, so preRun
    // can register them synchronously. Each provider sees MOUNT-RELATIVE paths (the
    // WasmFS ProviderBackend accumulates from its mount root). /profile = read-write
    // persistent (default: OPFS at DEFAULT_PROFILE_PATH); /gre = an optional provider
    // consulted FIRST, with the baked gecko.data as fallback. Either option may be a
    // provider object or a string OPFS path.
    // Split each mount into a native-OPFS sub-path (string) vs a custom provider
    // object. String -> native OPFS backend at /opfs/<path> (fast). Object -> the
    // proxy-to-R ProviderBackend. The default profile is a string path, so it too
    // gets the native backend.
    let profOpfsPath: string | undefined;
    let profProv: ProfileProvider | undefined;
    if (typeof this.opts.profile === 'string') profOpfsPath = this.opts.profile;
    else if (this.opts.profile) profProv = this.opts.profile;
    else profOpfsPath = DEFAULT_PROFILE_PATH;

    let greOpfsPath: string | undefined;
    let greProv: FsProvider | undefined;
    if (typeof this.opts.fs === 'string') greOpfsPath = this.opts.fs;
    else if (this.opts.fs) greProv = this.opts.fs;
    // else: no `fs` -> the baked gecko.data only.

    const moduleOpts: Record<string, unknown> = {
      print: (t: string) => {
        if (typeof t === 'string' && t.includes('READY cmd=')) resolveReady();
        print(t);
      },
      printErr,
      onAbort: (w: unknown) => printErr('[libxul] abort: ' + w),
      // Called from the Renderer worker via CMD_CALL_HANDLER for the first few
      // presents (lib/gl-present.js). MUST exist before any thread starts:
      // emscripten's dispatch does a bare `Module[d.handler](...)`, no null check.
      geckoOnPresent: (n: number) => this.onPresent(n),
      // Called from RenderLoadListener::OnLocationChange (embed-browser.cpp) on
      // the main thread via EM_ASM. Optional — older discs never fire it.
      geckoOnLocationChange: (url: string) => {
        try {
          this.opts.onLocationChange?.(url);
        } catch {
          /* embedder bugs must not tear the engine */
        }
      },
      preRun: [(m: GeckoModule) => {
        // GPU mode resolves its compositor canvas by SELECTOR ("#screen", hardcoded
        // in GLContextProviderEmscripten). Hand the engine our actual element before
        // it looks, so an embedder whose canvas lives in a shadow root works.
        if (this.gpu) this.registerGlTarget(m);
        // Mount selection (done in xul_init, gated on these ENV vars since the JS
        // geckoProviders object isn't visible on the engine pthreads):
        //  - string path  -> native OPFS backend at /opfs (GECKO_OPFS_MOUNT); the
        //    GRE/profile dirs are /opfs/<path>.
        //  - FsProvider    -> proxy-to-R ProviderBackend at /gre or /profile.
        //  - no `fs`       -> the baked gecko.data preloaded at /gre-baked.
        if (greOpfsPath || profOpfsPath) m.ENV['GECKO_OPFS_MOUNT'] = '1';
        m.ENV['GRE_DIR'] = greOpfsPath ? opfsAbs(greOpfsPath) : greProv ? '/gre' : '/gre-baked';
        if (profOpfsPath) m.ENV['PROFILE_DIR'] = opfsAbs(profOpfsPath);
        m.ENV['MOZ_FORCE_DISABLE_E10S'] = '1';
        // Default the chrome theme + content prefers-color-scheme to the HOST
        // browser's color scheme: read window.matchMedia here (runs on the page
        // thread, where it exists) and pass it to xul_init via GECKO_DARK ->
        // ui.systemUsesDarkTheme. Set BEFORE the opts.env merge so an explicit
        // env override still wins. (matchMedia is absent off the main thread; default light.)
        const hostMatchMedia = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
        m.ENV['GECKO_DARK'] = hostMatchMedia && hostMatchMedia('(prefers-color-scheme: dark)').matches ? '1' : '0';
        for (const [k, v] of Object.entries(this.opts.env ?? {})) m.ENV[k] = v;
        // The WISP transport (build/wisp-net.js, a --js-library) reads the
        // endpoint from Module.wispUrl and lazily opens the single WebSocket on
        // the runtime main thread when the first socket connects. When
        // tcpTransport is set, sockets route through that factory instead and
        // the WebSocket is never opened (wispUrl is unused).
        if (this.opts.wispUrl) (m as unknown as { wispUrl: string }).wispUrl = this.opts.wispUrl;
        if (this.opts.tcpTransport) {
          (m as unknown as { tcpTransport: TcpTransportFactory }).tcpTransport =
            this.opts.tcpTransport;
        }

        // Custom provider OBJECTS only: register them for the WasmFS ProviderBackend
        // (emsdk-patches/provider_backend.h + provider-fs.js). Its hooks run on the
        // runtime main thread R via proxySyncWithCtx and read Module.geckoProviders
        // here on R. The actual mount is done in C++ (xul_init) once the runtime is
        // up -- calling the _wasmfs_create_* export from preRun would be "before
        // runtime initialization" -- gated on the ENV flags below (ENV propagates to
        // the engine pthreads; this JS object does not). String paths use the native
        // OPFS backend instead and skip all of this.
        const mm = m as unknown as { geckoProviders: Record<number, unknown> };
        mm.geckoProviders = {};
        if (profProv) { mm.geckoProviders[PROFILE_MOUNT] = profProv; m.ENV['GECKO_PROFILE_PROVIDER'] = '1'; }
        if (greProv) { mm.geckoProviders[GRE_MOUNT] = greProv; m.ENV['GECKO_GRE_PROVIDER'] = '1'; }
      }],
    };
    // pthread workers load the (bundled) runtime from this Blob (emscripten 6.0.x spawns
    // them from the main module, no separate *.worker.js). The wasm is supplied directly
    // via instantiateWasm (below) and gecko.data via getPreloadedPackage, so emscripten
    // never fetches by filename -- locateFile is only honored if the consumer overrides it.
    moduleOpts.mainScriptUrlOrBlob = geckoBlobUrl();
    if (this.opts.locateFile) moduleOpts.locateFile = this.opts.locateFile;
    // Hand the runtime our canvas as Module.canvas — emscripten's canonical
    // "this is the app's canvas" slot. The OffscreenCanvas transfer path checks
    // `Module.canvas && Module.canvas.id === name` BEFORE falling back to
    // document.querySelector(name), and that querySelector is the one lookup
    // specialHTMLTargets does not cover. Without this, an embedder whose canvas
    // lives in a shadow root never gets the transfer: the worker then finds no
    // canvas and silently takes the proxied-context path, which renders but
    // never implicit-presents to the placeholder — a permanently blank surface.
    moduleOpts.canvas = this.canvas;

    // Decode the inlined gecko.data.zst with zstddec and feed it to emscripten via
    // getPreloadedPackage (so the .data is never fetched). The engine wasm comes from
    // wasm.url: when wasm.compressed it's a zstd .zst we decode here (uncompressed size
    // from the inlined manifest); otherwise it's stream-compiled directly.
    {
      const decoder = new ZSTDDecoder();
      await decoder.init();
      const dataZst = new Uint8Array(await (await fetch(geckoDataZst)).arrayBuffer());
      // emscripten passes the uncompressed package size; decode is synchronous.
      moduleOpts.getPreloadedPackage = (_name: string, size: number): ArrayBuffer => {
        const u = decoder.decode(dataZst, size);
        return u.byteLength === u.buffer.byteLength
          ? (u.buffer as ArrayBuffer)
          : (u.slice().buffer as ArrayBuffer);
      };
      moduleOpts.instantiateWasm = (imports: any, success: any) => {
        (async () => {
          let r: WebAssembly.WebAssemblyInstantiatedSource;
          if (wasmCompressed) {
            const zst = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
            const bytes = decoder.decode(zst, assets.wasmSize);
            r = await WebAssembly.instantiate(bytes as BufferSource, imports);
          } else {
            try {
              r = await WebAssembly.instantiateStreaming(fetch(wasmUrl), imports);
            } catch {
              // streaming needs an application/wasm response; fall back to a buffer fetch.
              const bytes = await (await fetch(wasmUrl)).arrayBuffer();
              r = await WebAssembly.instantiate(bytes, imports);
            }
          }
          success(r.instance, r.module);
        })().catch((e) => printErr('[libxul] wasm instantiate failed: ' + e));
        return {};
      };
    }

    if (this.opts.onContextMenu) {
      moduleOpts.geckoOnContextMenu = (info: GeckoContextMenuInfo) => {
        try { this.opts.onContextMenu?.(info); } catch { /* embedder bugs */ }
      };
    }
    if (this.hostPopups) {
      // C++ HostWantsPopups() only checks typeof === 'function'. Pixel delivery
      // is the command-result protocol decoded in blit(), not this stub.
      moduleOpts.geckoOnPopups = () => {};
    }

    this.mod = await createGecko(moduleOpts);
    await ready;
    this.cmd = this.mod._xul_cmd_ptr();

    // Software mode never calls gl_present_yield (no compositor present to wait
    // for -- the paint loop pulls each frame and blits it), so nothing would ever
    // resolve firstPaint. The engine is up and the loop is about to start, which is
    // as close to "there will be pixels" as this mode gets.
    if (!this.gpu) this.resolveFirstPaint();

    if (this.opts.forwardInput !== false) this.attachInput();
    this.startPaintLoop();
  }

  /** Navigate the embedded engine to a URL (http(s):// fetched over WISP). */
  async load(url: string): Promise<void> {
    await this.run({ op: OP_LOAD, url });
    // Arms firstPaint: from here, the next present is one that can carry this
    // document. (Presents that already happened may predate it.)
    this.loadSettled = true;
  }

  /**
   * Resize the rendering surface. The engine reads the new dimensions from the
   * next command and reflows/recomposites to fit. Software mode resizes the 2D
   * canvas backing; GPU mode resizes the canvas box (the transferred #screen
   * drawing buffer is owned by the engine, so only its CSS size is set here) and
   * the #glout overlay follows. Safe to call repeatedly at runtime.
   */
  async resize(width: number, height: number): Promise<void> {
    this.W = Math.max(1, Math.round(width));
    this.H = Math.max(1, Math.round(height));
    if (this.gpu) {
      this.syncGpuSize();
    } else {
      this.canvas.width = this.W;
      this.canvas.height = this.H;
      this.blitImg = null;
      this.blitDst32 = null;
    }
    await this.run({ op: OP_PAINT });
  }

  /** Evaluate JS in the chrome context; returns the stringified result. */
  async evalChrome(js: string): Promise<string> {
    const r = await this.run({ op: OP_EVAL, url: js });
    return typeof r === 'string' ? r : '';
  }

  /** Session history back (content `history.back()`). */
  async goBack(): Promise<void> {
    await this.evalChrome('history.back(); ""');
  }

  /** Session history forward. */
  async goForward(): Promise<void> {
    await this.evalChrome('history.forward(); ""');
  }

  /** Roll up any open XUL popups (host dismissed a popup Surface). */
  async rollup(): Promise<void> {
    await this.run({ op: OP_ROLLUP });
  }

  /** Inject a mouse event in engine CSS px (popup Surfaces forward here). */
  async sendMouse(opts: {
    evType: number; x: number; y: number;
    button?: number; buttons?: number; modifiers?: number; clickCount?: number;
  }): Promise<void> {
    await this.run({
      op: OP_MOUSE,
      evType: opts.evType,
      x: opts.x, y: opts.y,
      button: opts.button ?? 0,
      buttons: opts.buttons ?? -1,
      clickCount: opts.clickCount ?? 0,
      modifiers: opts.modifiers ?? 0,
    });
  }

  async sendWheel(opts: {
    x: number; y: number; deltaX: number; deltaY: number; modifiers?: number;
  }): Promise<void> {
    await this.run({
      op: OP_WHEEL, x: opts.x, y: opts.y,
      deltaX: opts.deltaX, deltaY: opts.deltaY,
      modifiers: opts.modifiers ?? 0,
    });
  }

  /** Stop loops, detach input handlers. (The wasm module is not torn down.) */
  destroy(): void {
    this.running = false;
    for (const d of this.detach) d();
    this.detach = [];
  }

  // Register our canvas in emscripten's selector override map, so the engine's
  // emscripten_webgl_create_context("#screen") resolves to THIS element instead of
  // going through document.querySelector.
  //
  // Why it matters: findCanvasEventTarget(target) checks
  // GL.offscreenCanvases[target.slice(1)], then findEventTarget(target) ->
  // specialHTMLTargets[target] || document.querySelector(target). An embedder that
  // mounts the canvas inside a SHADOW ROOT (an isolated app window, a web component)
  // is invisible to querySelector, so without this the lookup returns null and
  // WebRenderAPI::Create dereferences a null GL context -> trap. Registering the
  // element directly also makes the id="screen" assignment in the constructor
  // non-load-bearing, so two Gecko instances on one page no longer fight over a
  // document-unique id -- each engine instance has its own map.
  //
  // Must run before the engine creates its GL context; preRun is the latest safe
  // point (it runs before main).
  private registerGlTarget(m: GeckoModule): void {
    const targets = m.specialHTMLTargets;
    if (!targets) {
      (this.opts.printErr ?? ((s: string) => console.warn(s)))(
        '[libxul] specialHTMLTargets is not exported by this engine build; GPU mode ' +
        'will fall back to document.querySelector("#screen") and cannot find a canvas ' +
        'inside a shadow root. Rebuild with specialHTMLTargets in ' +
        '-sEXPORTED_RUNTIME_METHODS (see gecko.js/build-lib.sh).');
      return;
    }
    // Both spellings: findEventTarget keys on the raw selector ("#screen"), while
    // findCanvasEventTarget strips the leading '#' before its offscreen-canvas lookup.
    targets['#screen'] = this.canvas;
    targets['screen'] = this.canvas;
  }

  // ---- command protocol --------------------------------------------------

  private run(item: Cmd): Promise<number | string | null> {
    return new Promise((resolve) => {
      item.resolve = resolve;
      // coalesce consecutive mouse-moves so fast motion can't back up the queue.
      const last = this.queue[this.queue.length - 1];
      if (item.op === OP_MOUSE && item.evType === 0 && last &&
          last.op === OP_MOUSE && last.evType === 0) {
        this.queue[this.queue.length - 1] = item;
      } else {
        this.queue.push(item);
      }
      this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const item = this.queue.shift()!;
      const r = await this.runCmd(item);
      item.resolve?.(r);
    }
    this.running = false;
  }

  private async runCmd(item: Cmd): Promise<number | string | null> {
    const m = this.mod!;
    const i32 = () => m.HEAP32, u8 = () => m.HEAPU8;
    const set = (off: number, v: number) => { i32()[(this.cmd + off) >> 2] = v | 0; };
    try {
      const vw = (globalThis as { innerWidth?: number }).innerWidth || this.W;
      const vh = (globalThis as { innerHeight?: number }).innerHeight || this.H;
      (m as unknown as { geckoScreen?: { sw: number; sh: number } }).geckoScreen =
        { sw: vw, sh: vh };
    } catch { /* no window */ }
    set(W, this.W); set(H, this.H);
    set(OP, item.op);
    set(EVTYPE, item.evType || 0);
    set(EX, item.x || 0); set(EY, item.y || 0);
    set(BTN, item.button || 0);
    set(BTNS, item.buttons == null ? -1 : item.buttons);
    set(CLICKS, item.clickCount || 0);
    set(MODS, item.modifiers || 0);
    set(KEYCODE, item.keyCode || 0);
    set(CHARCODE, item.charCode || 0);
    set(DX, item.deltaX || 0); set(DY, item.deltaY || 0);
    if (item.op === OP_LOAD || item.op === OP_EVAL || item.op === OP_CLIP_SET) {
      const bytes = this.enc.encode(item.url || '');
      if (bytes.length >= 8190) return null;
      u8().set(bytes, this.cmd + URLOFF); u8()[this.cmd + URLOFF + bytes.length] = 0;
    }
    if (item.op === OP_KEY) {
      const kb = this.enc.encode(item.key || '');
      const n = Math.min(kb.length, 63);
      u8().set(kb.subarray(0, n), this.cmd + KEYVAL); u8()[this.cmd + KEYVAL + n] = 0;
    }
    Atomics.store(i32(), (this.cmd + ST) >> 2, 1);
    // Wake the engine thread immediately: it sleeps (emscripten_futex_wait) on this
    // word when idle instead of busy-polling, so the command is picked up at once.
    Atomics.notify(i32(), (this.cmd + ST) >> 2, 1);
    const start = performance.now();
    let st = 1;
    while (performance.now() - start < 120000) {
      st = Atomics.load(i32(), (this.cmd + ST) >> 2);
      if (st === 3 || st === -1) break;
      await new Promise((r) => setTimeout(r, item.op === OP_LOAD ? 20 : 4));
    }
    if (st !== 3) return null;
    if (item.op >= 5 && item.op <= 8) {
      const resPtr = i32()[(this.cmd + RES) >> 2], len = i32()[(this.cmd + LEN) >> 2];
      return (resPtr && len)
        ? this.dec.decode(new Uint8Array(u8().subarray(resPtr, resPtr + len)))
        : '';
    }
    const n = this.blit();
    if (item.op === OP_MOUSE) {
      const ck = i32()[(this.cmd + CURSOR) >> 2];
      this.canvas.style.cursor = CURSORS[ck] || 'auto';
    }
    return n;
  }

  // BGRA (engine) -> RGBA (canvas), a 32-bit word at a time, reusing one ImageData.
  private blit(): number {
    const m = this.mod!;
    const i32 = m.HEAP32, u8 = m.HEAPU8;
    const resPtr = i32[(this.cmd + RES) >> 2], len = i32[(this.cmd + LEN) >> 2];
    // GPU mode: WebRender already presented the main scene to #glout; the result
    // buffer (if any) is the popup overlay. Draw it on the 2D overlay above #glout.
    if (this.gpu) {
      if (this.hostPopups) { this.emitHostPopups(resPtr, len); return 0; }
      this.drawPopupOverlay(resPtr, len);
      return 0;
    }
    if (!this.ctx) return 0;
    if (!resPtr || !len) return 0;
    if (!this.blitImg) {
      this.blitImg = this.ctx.createImageData(this.W, this.H);
      this.blitDst32 = new Uint32Array(this.blitImg.data.buffer);
    }
    const n = len >>> 2;
    // The engine pthread may have grown the shared heap after we read resPtr/len;
    // this thread's HEAPU8 view can lag, so a [resPtr, resPtr+len) view would run
    // past the buffer -> "Invalid typed array length" RangeError (crashes pump).
    // Skip this frame; the next blit (after the view catches up) paints it.
    if ((resPtr & 3) || resPtr + len > u8.buffer.byteLength) return 0;
    const src32 = new Uint32Array(u8.buffer, resPtr, n);
    const dst = this.blitDst32!;
    let nonWhite = 0;
    for (let i = 0; i < n; i++) {
      const p = src32[i];
      dst[i] = ((p >>> 16) & 0xFF) | (p & 0x0000FF00) | ((p & 0xFF) << 16) | 0xFF000000;
      if ((p & 0x00FFFFFF) !== 0x00FFFFFF) nonWhite++;
    }
    this.ctx.putImageData(this.blitImg, 0, 0);
    return nonWhite;
  }

  private emitHostPopups(resPtr: number, len: number): void {
    const popups: GeckoPopup[] = [];
    if (resPtr && len >= 4) {
      const u8 = this.mod!.HEAPU8;
      if (!((resPtr & 3) || resPtr + len > u8.buffer.byteLength)) {
        const view = new DataView(u8.buffer, resPtr, len);
        const count = view.getUint32(0, true);
        let off = 4;
        for (let i = 0; i < count; i++) {
          if (off + 24 > len) break;
          const id = view.getInt32(off, true);
          const x = view.getInt32(off + 4, true);
          const y = view.getInt32(off + 8, true);
          const w = view.getInt32(off + 12, true);
          const h = view.getInt32(off + 16, true);
          const plen = view.getUint32(off + 20, true);
          off += 24;
          if (off + plen > len) break;
          const pixels = new Uint8Array(plen);
          pixels.set(u8.subarray(resPtr + off, resPtr + off + plen));
          off += plen;
          off += (4 - (plen % 4)) % 4;
          popups.push({ id, x, y, w, h, pixels });
        }
      }
    }
    this.popupShown = popups.length > 0;
    try { this.opts.onPopups?.(popups); } catch { /* embedder bugs */ }
  }

  // GPU mode: draw the engine's popup overlay buffer (BGRA: transparent backdrop +
  // opaque popup pixels) onto the 2D #popup-overlay canvas above #glout. A null/empty
  // result means no popup is open -> clear the overlay (dismisses the last popup).
  // putImageData replaces the whole canvas, so a shrunken/moved popup leaves no trail.
  private drawPopupOverlay(resPtr: number, len: number): void {
    const octx = this.popupCtx;
    if (!octx) return;
    if (!resPtr || !len) {
      if (this.popupShown) { octx.clearRect(0, 0, this.W, this.H); this.popupShown = false; }
      return;
    }
    if (!this.popupImg || this.popupImg.width !== this.W || this.popupImg.height !== this.H) {
      this.popupImg = octx.createImageData(this.W, this.H);
      this.popupDst32 = new Uint32Array(this.popupImg.data.buffer);
    }
    const buf = this.mod!.HEAPU8.buffer;
    const n = len >>> 2;
    // See blit(): guard against the shared heap growing under us (this thread's view
    // lagging) or a bad/misaligned ptr -- otherwise the view overruns the buffer and
    // throws "Invalid typed array length", crashing the pump. Skip this frame.
    if ((resPtr & 3) || resPtr + len > buf.byteLength) return;
    const src32 = new Uint32Array(buf, resPtr, n);
    const dst = this.popupDst32!;
    // BGRA -> RGBA, PRESERVING source alpha (unlike blit(), which forces opaque).
    for (let i = 0; i < n; i++) {
      const p = src32[i];
      dst[i] = ((p >>> 16) & 0xFF) | (p & 0x0000FF00) | ((p & 0xFF) << 16) | (p & 0xFF000000);
    }
    octx.putImageData(this.popupImg, 0, 0);
    this.popupShown = true;
  }

  private startPaintLoop(): void {
    if (!this.gpu) {
      // Software mode: the engine paints the whole frame into a BGRA buffer; we must
      // pull + blit it every frame.
      const tick = async () => {
        if (!this.mod) return;
        await this.run({ op: OP_PAINT });
        if (this.mod) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return;
    }
    // GPU mode: the main scene presents autonomously -- the refresh driver composites
    // WebRender to #screen's OffscreenCanvas and SwapBuffers yields the Renderer thread
    // (JSPI), so the browser implicit-presents it to the #screen placeholder (no #glout;
    // see gl-present.js + embed-paint.cpp gpu_ensure_active). So op=PAINT is needed ONLY
    // to refresh the 2D popup overlay. Input commands already
    // return the overlay (a click/right-click/key that opens or closes a popup
    // repaints it via that op's result), so the overlay is event-driven for the
    // common cases. The loop then only polls: every frame WHILE a popup is open (live
    // hover/submenu/close/animation), and a low-rate idle poll otherwise to catch
    // timer-opened popups (tooltips). No per-frame op=PAINT in steady state.
    const IDLE_POLL_MS = 250;
    let lastPull = 0;
    const tick = async (now: number) => {
      if (!this.mod) return;
      const interval = this.popupShown ? 0 : IDLE_POLL_MS;
      if (now - lastPull >= interval) {
        lastPull = now;
        await this.run({ op: OP_PAINT });
      }
      if (this.mod) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ---- input -------------------------------------------------------------

  // GPU mode renders to #screen's transferred OffscreenCanvas and presents to the
  // #screen placeholder directly (the engine's SwapBuffers JSPI-yields so the browser
  // implicit-presents it -- see gl-present.js). So #screen IS the visible surface; we
  // only add a transparent popup overlay above it, inside a relative wrapper so the
  // overlay tracks the canvas box at whatever size the embedder picks (and resize()).
  private setupGpuPresent(): void {
    const c = this.canvas;
    let wrap = c.parentElement;
    if (!wrap || wrap.dataset.libxulGlwrap !== '1') {
      wrap = document.createElement('div');
      wrap.dataset.libxulGlwrap = '1';
      c.parentNode!.insertBefore(wrap, c);
      wrap.appendChild(c);
    }
    wrap.style.position = 'relative';
    wrap.style.display = 'inline-block';
    wrap.style.lineHeight = '0';
    c.style.display = 'block';
    if (this.hostPopups) {
      this.syncGpuSize();
      return;
    }
    // Popup overlay: a 2D canvas stacked ABOVE #screen (popups must draw over the main
    // scene). zIndex 2 so it wins; pointer-events none so input still reaches #screen.
    // drawPopupOverlay() paints the engine's popup buffer here.
    let ov = this.popupCanvas;
    if (!ov) {
      ov = document.createElement('canvas');
      // Kept for debuggability only -- nothing looks the overlay up by id (see the
      // popupCanvas field). Inside a shadow root the id is scoped to that root, so
      // per-instance overlays don't collide.
      ov.id = 'popup-overlay';
      ov.style.position = 'absolute';
      ov.style.left = '0';
      ov.style.top = '0';
      ov.style.zIndex = '2';
      ov.style.pointerEvents = 'none';
      wrap.appendChild(ov);
      this.popupCanvas = ov;
    }
    this.popupCtx = ov.getContext('2d');
    this.syncGpuSize();
  }

  // Set every surface to the real pixel size (no CSS down/upscaling): the wrapper box,
  // the #screen box, and the popup overlay's backing AND css all equal W*H.
  private syncGpuSize(): void {
    const c = this.canvas;
    const wrap = c.parentElement;
    if (wrap && wrap.dataset.libxulGlwrap === '1') {
      wrap.style.width = this.W + 'px';
      wrap.style.height = this.H + 'px';
    }
    c.style.width = this.W + 'px';
    c.style.height = this.H + 'px';
    const el = this.popupCanvas;
    if (el) {
      el.width = this.W;
      el.height = this.H;
      el.style.width = this.W + 'px';
      el.style.height = this.H + 'px';
    }
    // Resizing the overlay canvas clears it; force a fresh popup paint next frame.
    this.popupImg = null;
    this.popupShown = false;
  }

  private mods(e: MouseEvent | KeyboardEvent | WheelEvent): number {
    return (e.altKey ? MOD_ALT : 0) | (e.ctrlKey ? MOD_CTRL : 0) |
           (e.shiftKey ? MOD_SHIFT : 0) | (e.metaKey ? MOD_META : 0);
  }

  private xy(e: MouseEvent | WheelEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - r.left) * (this.W / r.width)),
      y: Math.round((e.clientY - r.top) * (this.H / r.height)),
    };
  }

  private attachInput(): void {
    const c = this.canvas;
    const on = <K extends keyof HTMLElementEventMap>(t: K, h: (e: HTMLElementEventMap[K]) => void) => {
      c.addEventListener(t, h as EventListener);
      this.detach.push(() => c.removeEventListener(t, h as EventListener));
    };
    on('mousemove', (e) => { const p = this.xy(e); this.lastPtr = p; this.run({ op: OP_MOUSE, evType: 0, x: p.x, y: p.y, buttons: e.buttons, modifiers: this.mods(e) }); });
    on('mousedown', (e) => { c.focus(); const p = this.xy(e); this.lastPtr = p; this.run({ op: OP_MOUSE, evType: 1, x: p.x, y: p.y, button: e.button, buttons: e.buttons, clickCount: e.detail, modifiers: this.mods(e) }); });
    on('mouseup', (e) => { const p = this.xy(e); this.lastPtr = p; this.run({ op: OP_MOUSE, evType: 2, x: p.x, y: p.y, button: e.button, buttons: e.buttons, clickCount: e.detail, modifiers: this.mods(e) }); });
    // Forward the contextmenu (evType=3) to the engine: a synthesized right
    // mousedown/up alone doesn't generate eContextMenu in the headless build, so
    // without this no context menu ever opens (embed-xul.cpp do_mouse).
    on('contextmenu', (e) => { e.preventDefault(); const p = this.xy(e); this.lastPtr = p; this.run({ op: OP_MOUSE, evType: 3, x: p.x, y: p.y, button: 2, buttons: e.buttons, modifiers: this.mods(e) }); });
    on('wheel', (e) => { const p = this.xy(e); this.run({ op: OP_WHEEL, x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: this.mods(e) }); e.preventDefault(); });
    // Printable keys carry their char code (matches the original embed-xul loader).
    // The engine doesn't insert text for Ctrl/Meta combos anyway (the editor's
    // IsInputtingText() is false when a command modifier is held), and sending the
    // char keeps the keypress shape the shortcut handler expects.
    const keyItem = (e: KeyboardEvent, evType: number): Cmd => ({
      op: OP_KEY, evType, key: e.key, keyCode: e.keyCode,
      charCode: e.key.length === 1 ? e.key.codePointAt(0)! : 0,
      modifiers: this.mods(e),
    });
    on('keydown', (e) => {
      // Paste needs the real system clipboard, which is async (navigator.clipboard
      // .readText) while the engine's paste is synchronous. So intercept Ctrl/Cmd+V,
      // read the clipboard, push it into the engine's clipboard, THEN forward the
      // key so the engine pastes natively. Copy/cut stay fully native (the engine's
      // headless clipboard mirrors out to navigator.clipboard on SetData).
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey &&
          (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        void this.pasteThenKey(keyItem(e, 0));
        return;
      }
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        const p = this.lastPtr;
        this.run({ op: OP_MOUSE, evType: 3, x: p.x, y: p.y, button: 2, buttons: 0, modifiers: this.mods(e) });
        return;
      }
      this.run(keyItem(e, 0));
      e.preventDefault();
    });
    on('keyup', (e) => { this.run(keyItem(e, 1)); e.preventDefault(); });
    if (!c.hasAttribute('tabindex')) c.setAttribute('tabindex', '0');
  }

  // Prime the engine's clipboard from the system clipboard, then forward the paste
  // key. The serial command queue guarantees the OP_CLIP_SET lands before the key,
  // so the engine's native cmd_paste reads the just-written text.
  private async pasteThenKey(key: Cmd): Promise<void> {
    try {
      const text = navigator.clipboard?.readText ? await navigator.clipboard.readText() : '';
      if (text) await this.run({ op: OP_CLIP_SET, url: text });
    } catch (e) {
      (this.opts.printErr ?? ((s: string) => console.warn(s)))(
        '[libxul] clipboard read: ' + (e instanceof Error ? e.message : String(e)));
    }
    this.run(key);
  }
}

export default Gecko;
