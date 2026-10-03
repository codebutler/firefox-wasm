// Boot the site's REAL app bundle (864 KB three.js game) inside a stub DOM.
// Measures parse+compile+top-level init of the actual script this page ships,
// then pumps a few requestAnimationFrame ticks so the per-frame path runs too.
// Checksum = total stub-DOM interactions (deterministic: Math.random is seeded,
// performance.now is a fixed counter). If the bundle dies deep in WebGL init,
// the checksum still reflects exactly how far real init got.

function makeEnv(counter) {
  const rafQ = [];
  const tick = { t: 0 };
  const bump = (n = 1) => { counter.n += n; };

  const fallback = new Proxy(function () {}, {
    get(t, k) {
      if (k === Symbol.iterator) return function* () {};
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === "then" || k === "catch" || k === "finally") return undefined;
      bump(); return fallback;
    },
    set() { bump(); return true; },
    has() { return true; },
    apply() { bump(); return fallback; },
    construct() { bump(); return fallback; },
  });

  const gl = new Proxy(function () {}, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => 0;
      switch (k) {
        case "getError": return () => 0;
        case "getParameter": return () => "";
        case "getShaderPrecisionFormat": return () => ({ rangeMin: 127, rangeMax: 127, precision: 23 });
        case "getContextAttributes": return () => ({});
        case "checkFramebufferStatus": return () => 36053;
        case "createBuffer": case "createTexture": case "createProgram":
        case "createShader": case "createFramebuffer": case "createRenderbuffer":
        case "createVertexArray": case "getUniformLocation": case "createQuery":
        case "createSampler": case "createTransformFeedback": case "fenceSync":
          return () => ({});
        case "getShaderParameter": case "getProgramParameter": case "isContextLost":
          return () => true;
        case "getSupportedExtensions": return () => [];
        case "getExtension": return () => null;
        case "getShaderInfoLog": case "getProgramInfoLog": return () => "";
      }
      bump(); return (...a) => { bump(); return undefined; };
    },
    has() { return true; },
  });

  const mkEl = (tag) => {
    const el = {
      tagName: (tag || "div").toUpperCase(),
      style: {},
      children: [], childNodes: [],
      classList: { add: () => bump(), remove: () => bump(), toggle: () => bump(), contains: () => false },
      dataset: {},
      clientWidth: 1280, clientHeight: 720,
      offsetWidth: 1280, offsetHeight: 720,
      innerText: "", textContent: "", id: "",
      appendChild: (c) => { bump(); el.children.push(c); return c; },
      insertBefore: (c) => { bump(); return c; },
      removeChild: (c) => { bump(); return c; },
      append: () => bump(), prepend: () => bump(),
      remove: () => bump(),
      setAttribute: () => bump(),
      getAttribute: () => null,
      hasAttribute: () => false,
      addEventListener: () => bump(),
      removeEventListener: () => bump(),
      dispatchEvent: () => true,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720, x: 0, y: 0 }),
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null,
      getContext: (kind) => { bump(); return kind === "2d" ? ctx2d() : gl; },
      toDataURL: () => "",
      setPointerCapture: () => {}, releasePointerCapture: () => {}, hasPointerCapture: () => false,
      focus: () => {}, blur: () => {}, click: () => {},
      cloneNode: () => mkEl(tag),
      insertAdjacentHTML: () => bump(),
      animate: () => ({ cancel: () => {}, finish: () => {}, addEventListener: () => {} }),
      ownerDocument: null, parentNode: null, firstChild: null, lastChild: null,
      nodeType: 1, nodeName: (tag || "div").toUpperCase(),
    };
    return el;
  };

  const ctx2d = () => new Proxy(function () {}, {
    get(t, k) {
      if (k === "canvas") return mkEl("canvas");
      if (k === "measureText") return () => ({ width: 0 });
      if (k === "getImageData") return (x, y, w, h) => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      if (k === "createImageData" || k === "createLinearGradient" || k === "createRadialGradient" || k === "createPattern")
        return () => ({ addColorStop: () => {} });
      bump(); return typeof k === "string" ? (() => { bump(); }) : undefined;
    },
    set() { bump(); return true; },
    has() { return true; },
  });

  const listeners = {};
  const docObj = {
    readyState: "complete", hidden: false, visibilityState: "visible",
    documentElement: mkEl("html"),
    head: mkEl("head"), body: mkEl("body"),
    createElement: (t) => { bump(); return mkEl(t); },
    createElementNS: (ns, t) => { bump(); return mkEl(t); },
    createTextNode: (t) => ({ nodeValue: t, textContent: t, nodeType: 3 }),
    createDocumentFragment: () => mkEl("#fragment"),
    createRange: () => ({ selectNodeContents: () => {}, setStart: () => {}, setEnd: () => {}, collapse: () => {}, cloneContents: () => mkEl("#frag"), getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) }),
    querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => null,
    getElementsByTagName: () => [], getElementsByClassName: () => [],
    elementsFromPoint: () => [],
    addEventListener: (n, f) => { bump(); (listeners[n] ??= []).push(f); },
    removeEventListener: () => bump(),
    dispatchEvent: () => true,
    fonts: { add: () => {}, load: () => Promise.resolve([]), ready: Promise.resolve(), check: () => false, forEach: () => {}, values: () => [][Symbol.iterator]() },
    cookie: "", title: "", characterSet: "UTF-8", compatMode: "CSS1Compat",
    activeElement: null, scrollingElement: null,
    execCommand: () => false, hasFocus: () => true,
    getSelection: () => null,
  };
  const document = new Proxy(docObj, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === Symbol.iterator) return undefined;
      bump(); return fallback;
    },
    set(t, k, v) { t[k] = v; return true; },
    has() { return true; },
  });
  for (const el of [docObj.documentElement, docObj.head, docObj.body]) el.ownerDocument = document;

  const observer = class {
    constructor(cb) { this.cb = cb; }
    observe() { bump(); } unobserve() {} disconnect() {}
    takeRecords() { return []; }
  };

  const storage = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null,
      get length() { return m.size; } };
  };

  const perf = { now: () => (tick.t += 16.6667), timeOrigin: 0, mark: () => {}, measure: () => {}, clearMarks: () => {}, clearMeasures: () => {}, getEntries: () => [], getEntriesByName: () => [], getEntriesByType: () => [] };

  const win = {
    innerWidth: 1280, innerHeight: 720, devicePixelRatio: 2,
    outerWidth: 1280, outerHeight: 720, screenX: 0, screenY: 0,
    scrollX: 0, scrollY: 0, pageXOffset: 0, pageYOffset: 0,
    addEventListener: (n, f) => { bump(); (listeners[n] ??= []).push(f); },
    removeEventListener: () => bump(),
    dispatchEvent: () => true,
    requestAnimationFrame: (f) => { bump(); rafQ.push(f); return rafQ.length; },
    cancelAnimationFrame: () => bump(),
    setTimeout: () => { bump(); return 0; },
    clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    queueMicrotask: (f) => { try { f(); } catch (e) {} },
    matchMedia: (q) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => true }),
    getComputedStyle: () => new Proxy({}, { get: (t, k) => (k === "getPropertyValue" ? () => "" : "") }),
    getSelection: () => null,
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve(""), arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)), blob: () => Promise.resolve({}), headers: new Map() }),
    location: { href: "https://vibey-clover.krz-tech.workers.dev/", origin: "https://vibey-clover.krz-tech.workers.dev", protocol: "https:", host: "vibey-clover.krz-tech.workers.dev", hostname: "vibey-clover.krz-tech.workers.dev", pathname: "/", search: "", hash: "", assign: () => {}, replace: () => {}, reload: () => {} },
    navigator: { userAgent: "jit-bench/1.0", language: "ja", languages: ["ja"], platform: "bench", hardwareConcurrency: 8, maxTouchPoints: 0, vendor: "", appVersion: "5.0", cookieEnabled: true, onLine: true, getGamepads: () => [], mediaDevices: {}, permissions: { query: () => Promise.resolve({ state: "denied" }) }, sendBeacon: () => true },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, orientation: { type: "landscape-primary", angle: 0, addEventListener: () => {} } },
    history: { pushState: () => {}, replaceState: () => {}, back: () => {}, forward: () => {}, go: () => {}, state: null, length: 1 },
    localStorage: storage(), sessionStorage: storage(),
    performance: perf,
    MutationObserver: observer, ResizeObserver: observer, IntersectionObserver: observer,
    PerformanceObserver: observer,
    Image: class { set src(v) {} addEventListener() {} },
    Audio: class { play() { return Promise.resolve(); } pause() {} addEventListener() {} },
    AudioContext: class { constructor() { this.state = "running"; this.destination = {}; this.currentTime = 0; } resume() { return Promise.resolve(); } createGain() { return { gain: { value: 0 }, connect() {} }; } createOscillator() { return { frequency: { value: 0 }, type: "", connect() {}, start() {}, stop() {} }; } createBuffer() { return {}; } decodeAudioData(b, ok) { if (ok) ok({}); return Promise.resolve({}); } },
    Worker: class { postMessage() {} terminate() {} addEventListener() {} },
    XMLHttpRequest: class { open() {} send() {} addEventListener() {} setRequestHeader() {} },
    CustomEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
    Event: class { constructor(t) { this.type = t; } initEvent() {} },
    PointerEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
    KeyboardEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
    MouseEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
    TouchEvent: class { constructor(t) { this.type = t; } },
    WheelEvent: class { constructor(t) { this.type = t; } },
    FocusEvent: class { constructor(t) { this.type = t; } },
    InputEvent: class { constructor(t) { this.type = t; } },
    DragEvent: class { constructor(t) { this.type = t; } },
    PopStateEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
    URL: globalThis.URL, URLSearchParams: globalThis.URLSearchParams,
    TextDecoder: globalThis.TextDecoder, TextEncoder: globalThis.TextEncoder,
    HTMLCanvasElement: class {}, HTMLElement: class {}, HTMLVideoElement: class {}, HTMLImageElement: class {}, SVGElement: class {},
    OffscreenCanvas: class { constructor() { return mkEl("canvas"); } },
    requestIdleCallback: () => 0, cancelIdleCallback: () => {},
    document,
    scrollTo: () => {}, scrollBy: () => {}, open: () => null, close: () => {},
    alert: () => {}, confirm: () => false, prompt: () => null,
    crypto: globalThis.crypto || { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 31 + 7) & 255; return a; }, randomUUID: () => "00000000-0000-4000-8000-000000000000" },
    indexedDB: { open: () => ({ onsuccess: null, onerror: null, onupgradeneeded: null, result: null }) },
    BroadcastChannel: class { postMessage() {} close() {} addEventListener() {} },
    reportError: () => {},
    structuredClone: globalThis.structuredClone || ((o) => o),
    visualViewport: { width: 1280, height: 720, scale: 1, offsetLeft: 0, offsetTop: 0, addEventListener: () => {} },
    customElements: { define: () => {}, get: () => undefined, whenDefined: () => Promise.resolve() },
    Notification: { permission: "denied", requestPermission: () => Promise.resolve("denied") },
    speechSynthesis: { speak: () => {}, cancel: () => {}, getVoices: () => [] },
    caches: { open: () => Promise.reject(new Error("no caches")), match: () => Promise.resolve(undefined) },
    onerror: null, onunhandledrejection: null,
  };
  win.window = win;
  win.self = win;
  win.top = win; win.parent = win; win.frames = win;
  return { win, rafQ, listeners };
}

globalThis.Benchmark = class Benchmark {
  setup() {
    this.src = globalThis.SITE_JS_EVAL || globalThis.SITE_JS;
  }
  runIteration() {
    const counter = { n: 0 };
    const { win, rafQ } = makeEnv(counter);
    const keys = Object.keys(win);
    const saved = {};
    for (const k of keys) saved[k] = globalThis[k];
    const savedRand = Math.random;
    let rs = 987654321;
    Math.random = () => (rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    let err = "";
    const setG = (k, v) => {
      try { globalThis[k] = v; }
      catch (e) {
        try { Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true }); } catch (e2) {}
      }
    };
    try {
      for (const k of keys) setG(k, win[k]);
      const fn = new Function("window", "document", "self", "globalThis",
        "navigator", "location", "performance", "requestAnimationFrame",
        "cancelAnimationFrame", "setTimeout", "fetch",
        '"use strict";\n' + this.src);
      fn.call(win, win, win.document, win, win, win.navigator, win.location,
        win.performance, win.requestAnimationFrame, win.cancelAnimationFrame,
        win.setTimeout, win.fetch);
      for (let f = 0; f < 3 && rafQ.length; f++) {
        const q = rafQ.splice(0, rafQ.length);
        for (const cb of q) { try { cb(win.performance.now()); } catch (e) { err = err || String(e); } }
      }
    } catch (e) {
      err = String(e && e.message || e);
    } finally {
      Math.random = savedRand;
      for (const k of keys) {
        try {
          if (saved[k] === undefined) delete globalThis[k];
          else setG(k, saved[k]);
        } catch (e) {}
      }
    }
    this.calls = counter.n;
    this.err = err;
  }
  result() { return this.calls | 0; }
};
