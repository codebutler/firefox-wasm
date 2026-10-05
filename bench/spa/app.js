"use strict";
// ============================================================================
// bench/spa/app.js
//
// A heavy, realistic single-page-application workload in pure ES2020, written
// to be executed by the WebAssembly SpiderMonkey embed (bench/spidermonkey.js).
// It defines globalThis.Benchmark with:
//
//   setup()          build the entire app once (data, stores, components,
//                    routes, reactive pipeline, interaction script)
//   runIteration()   replay a deterministic burst of ~500 user interactions
//                    through the full reactive pipeline
//   result()         deterministic 32-bit checksum of final state + rendered
//                    output, so the harness can diff JIT vs interpreter
//
// Mini framework included:
//   reactive : signals / computed / effects with batched updates, dependency
//              graph, per-node versioning
//   scheduler: deterministic priority job queue with id dedup
//   vdom     : h() vnodes, function + class components with lifecycle hooks,
//              keyed list reconciliation, attribute/text diffing, serializer
//   router   : route table, params, nested paths, navigation, back/forward
//   store    : redux-like reducer store, memoized selector graph, middleware
//              chain, undo/redo snapshot middleware
//   other    : event bus, plugin host, JSON persistence + schema migrations,
//              i18n dictionary, command palette fuzzy search, validation
//
// Feature modules: home dashboard, todos, kanban board, sortable/filterable/
// paginated virtual-scrolled table, markdown-ish notes renderer, typed-array
// analytics, validated settings form, notification queue, command palette,
// undo/redo, i18n (en/de/fr), theme toggle.
//
// Hard rules honored: no DOM, no fetch/Promise/async/setTimeout, no Intl, no
// localeCompare/normalize, no require/import, no process, no console (local
// no-op), no Math.random (seeded PRNG), no Date.now() (fully deterministic).
// Nothing below ever throws (guarded everywhere).
// ============================================================================

// The shell may not provide console; install a local no-op so nothing below
// can depend on host I/O.
const console = {
  log() {}, info() {}, warn() {}, error() {}, debug() {}, trace() {}, time() {}, timeEnd() {},
};

const EMPTY_OBJ = {};
const EMPTY_ARR = [];
const VERSION = '1.0.3';

// ------------------------------------------------------------------ utilities

// Deterministic PRNG (mulberry32); replaces Math.random everywhere.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a 32-bit string hash.
function fnv1a(str) {
  let h = 0x811c9dc5;
  const n = str.length;
  for (let i = 0; i < n; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Mix two 32-bit values into one 32-bit value (xorshift/multiply avalanche).
function mix32(a, b) {
  let x = (a ^ b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

// Deterministic deep JSON serializer with sorted object keys. Mirrors
// JSON.stringify semantics (undefined/function/symbol props dropped, non-finite
// numbers become null) but with stable key order so checksums never depend on
// insertion order.
function stableStringify(value, depth) {
  depth = depth || 0;
  if (depth > 40) return '"<depth>"';
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'undefined' || t === 'function' || t === 'symbol') return 'null';
  if (t === 'number') return isFinite(value) ? String(value) : 'null';
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; i++) {
      if (i) out += ',';
      out += stableStringify(value[i], depth + 1);
    }
    return out + ']';
  }
  const keys = Object.keys(value).sort();
  let out = '{';
  let first = true;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = value[k];
    const vt = typeof v;
    if (v === undefined || vt === 'function' || vt === 'symbol') continue;
    out += (first ? '' : ',') + JSON.stringify(k) + ':' + stableStringify(v, depth + 1);
    first = false;
  }
  return out + '}';
}

// Simple argument memoizer (used for pure formatting caches).
function memoize(fn) {
  const cache = new Map();
  return function (arg) {
    if (cache.has(arg)) return cache.get(arg);
    const res = fn(arg);
    if (cache.size > 512) cache.clear();
    cache.set(arg, res);
    return res;
  };
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function setIn(obj, path, value) {
  const p = path[0];
  const rest = path.slice(1);
  const inner = rest.length ? setIn(obj[p], rest, value) : value;
  return Object.assign({}, obj, { [p]: inner });
}

// ----------------------------------------------------------------- global ids

let UID = 0;
let GSEQ = 0;
function nextId() {
  return (++UID) >>> 0;
}
function nextSeq() {
  return (++GSEQ) >>> 0;
}

// ------------------------------------------------------------------ scheduler

// A priority job queue used by the reactive pipeline (effects), the plugin
// host (deferred tasks) and store post-dispatch work. Jobs with the same id
// are deduplicated; flush() drains until stable (guarded so no pathological
// cascade can hang the engine).
class SchedulerQueue {
  constructor() {
    this._jobs = [];
    this._byId = new Map();
    this._flushing = false;
    this._order = 0;
    this.totalRuns = 0;
  }
  enqueue(fn, opts) {
    const id = opts && opts.id !== undefined && opts.id !== null ? opts.id : 'job' + nextSeq();
    const prio = (opts && opts.priority) | 0;
    const existing = this._byId.get(id);
    if (existing) {
      if (prio > existing.prio) existing.prio = prio;
      return existing;
    }
    const job = { id: id, fn: fn, prio: prio, seq: this._order++ };
    this._byId.set(id, job);
    this._jobs.push(job);
    return job;
  }
  _sort() {
    const j = this._jobs;
    const n = j.length;
    for (let i = 1; i < n; i++) {
      const cur = j[i];
      let k = i - 1;
      while (k >= 0 && (j[k].prio < cur.prio || (j[k].prio === cur.prio && j[k].seq > cur.seq))) {
        j[k + 1] = j[k];
        k--;
      }
      j[k + 1] = cur;
    }
  }
  flush() {
    if (this._flushing) return;
    this._flushing = true;
    let guard = 0;
    try {
      while (this._jobs.length) {
        if (++guard > 65536) break;
        this._sort();
        const job = this._jobs.shift();
        this._byId.delete(job.id);
        try {
          job.fn(job);
        } catch (e) {
          /* never throw out of the runtime */
        }
        this.totalRuns++;
      }
    } finally {
      this._flushing = false;
    }
  }
  reset() {
    this._jobs.length = 0;
    this._byId.clear();
    this._order = 0;
  }
  get size() {
    return this._jobs.length;
  }
}

const SCHEDULER = new SchedulerQueue();
let flushNesting = 0;

// Run fn and coalesce the scheduler flush at the outermost boundary.
function transact(fn) {
  flushNesting++;
  try {
    return fn();
  } finally {
    flushNesting--;
    if (flushNesting === 0) SCHEDULER.flush();
  }
}

// -------------------------------------------------------------------- signals

// Reactive core: SignalNode (state), ComputedNode (derived, lazily cached),
// EffectNode (scheduled side effects). Nodes form a dependency graph via
// Set-based subscriber bookkeeping with version invalidation; effects are
// queued on the scheduler and deduplicated, giving batched updates.
let CURRENT_CTX = null;

class SignalNode {
  constructor(value, name) {
    this.value = value;
    this.version = 0;
    this.subs = new Set();
    this.name = name || '';
  }
  get() {
    const c = CURRENT_CTX;
    if (c) c._track(this);
    return this.value;
  }
  set(value) {
    if (value !== this.value) {
      this.value = value;
      this.version++;
      this._notify();
    }
  }
  peek() {
    return this.value;
  }
  _notify() {
    for (const s of this.subs) s._dirty();
  }
  _dropSub(s) {
    this.subs.delete(s);
  }
}

class ComputedNode {
  constructor(fn, name) {
    this.fn = fn;
    this.name = name || 'c';
    this.deps = null;
    this.subs = new Set();
    this.value = undefined;
    this.valid = false;
    this.version = 0;
    this._inProgress = null;
  }
  get() {
    if (!this.valid) this._recompute();
    const c = CURRENT_CTX;
    if (c) c._track(this);
    return this.value;
  }
  peek() {
    if (!this.valid) this._recompute();
    return this.value;
  }
  _recompute() {
    const prev = CURRENT_CTX;
    CURRENT_CTX = this;
    this._inProgress = new Set();
    let res;
    try {
      res = this.fn();
    } catch (e) {
      res = undefined;
    }
    CURRENT_CTX = prev;
    const np = this._inProgress;
    this._inProgress = null;
    if (this.deps) {
      for (const d of this.deps) {
        if (!np.has(d)) d._dropSub(this);
      }
    }
    this.deps = np;
    this.value = res;
    this.valid = true;
    this.version++;
  }
  _track(node) {
    if (this._inProgress && !this._inProgress.has(node)) {
      this._inProgress.add(node);
      node.subs.add(this);
    }
  }
  _dirty() {
    if (this.valid) {
      this.valid = false;
      this._notify();
    }
  }
  _notify() {
    for (const s of this.subs) s._dirty();
  }
}

class EffectNode {
  constructor(fn, opts) {
    this.fn = fn;
    this.scheduler = (opts && opts.scheduler) || SCHEDULER;
    this.id = (opts && opts.id) || 'fx' + nextSeq();
    this.priority = ((opts && opts.priority) | 0) || 0;
    this.deps = null;
    this.queued = false;
    this.active = true;
    this.cleanup = null;
    this.runs = 0;
    this._inProgress = null;
  }
  _track(node) {
    if (this._inProgress && !this._inProgress.has(node)) {
      this._inProgress.add(node);
      node.subs.add(this);
    }
  }
  _dirty() {
    if (!this.active || this.queued) return;
    this.queued = true;
    this.scheduler.enqueue(() => this.run(), { id: this.id, priority: this.priority });
  }
  run() {
    if (!this.active) return;
    this.queued = false;
    if (this.cleanup) {
      const c = this.cleanup;
      this.cleanup = null;
      try {
        c();
      } catch (e) {
        /* never throw */
      }
    }
    const prev = CURRENT_CTX;
    CURRENT_CTX = this;
    this._inProgress = new Set();
    let res;
    try {
      res = this.fn();
    } catch (e) {
      res = undefined;
    }
    CURRENT_CTX = prev;
    const np = this._inProgress;
    this._inProgress = null;
    if (this.deps) {
      for (const d of this.deps) {
        if (!np.has(d)) d._dropSub(this);
      }
    }
    this.deps = np;
    this.lastResult = res;
    this.runs++;
  }
  destroy() {
    this.active = false;
    if (this.deps) {
      for (const d of this.deps) d._dropSub(this);
      this.deps = null;
    }
  }
}

function signal(init, name) {
  return new SignalNode(init, name);
}
function computed(fn, name) {
  return new ComputedNode(fn, name);
}
function effect(fn, opts) {
  const e = new EffectNode(fn, opts);
  e.run();
  return e;
}

// --------------------------------------------------------------------- vdom

// Hypertext-ish element factory. Children may be strings (text nodes), VNode,
// numbers, or nested arrays; null/undefined/booleans are dropped.
class VNode {
  constructor(tag, props, children) {
    this.tag = tag;
    this.props = props || EMPTY_OBJ;
    this.children = children || EMPTY_ARR;
  }
}

function childNodes(list) {
  const out = [];
  const stack = [];
  for (let i = list.length - 1; i >= 0; i--) stack.push(list[i]);
  while (stack.length) {
    const n = stack.pop();
    if (n == null || n === true || n === false) continue;
    if (Array.isArray(n)) {
      for (let j = n.length - 1; j >= 0; j--) stack.push(n[j]);
      continue;
    }
    const t = typeof n;
    if (t === 'string' || t === 'number') out.push(n);
    else if (n instanceof VNode) out.push(n);
  }
  return out;
}

function h(tag, props) {
  const rest = [];
  for (let i = 2; i < arguments.length; i++) rest.push(arguments[i]);
  const flat = rest.length === 1 && Array.isArray(rest[0]) ? childNodes(rest[0]) : childNodes(rest);
  return new VNode(tag, props, flat);
}

function compName(inst) {
  const c = inst && inst.constructor;
  if (c && c.name) return c.name;
  if (inst && inst.fn && inst.fn.name) return 'fn:' + inst.fn.name;
  return 'Anonymous';
}

// ---------------------------------------------------------------- components

// Class component base with lifecycle hooks. Instances are managed by the
// Renderer; setState pokes the reactive pipeline so the tree re-diffs
// (deterministically).
class Component {
  constructor(props) {
    this.props = props || EMPTY_OBJ;
    this.state = EMPTY_OBJ;
    this._version = 0;
    this._poke = null;
    this._mounted = false;
    this._updates = 0;
  }
  setState(partial) {
    this.state = Object.assign({}, this.state, partial);
    this._version++;
    if (this._poke) {
      try {
        this._poke();
      } catch (e) {
        /* never throw */
      }
    }
  }
  _attachPoke(fn) {
    this._poke = fn;
  }
  render() {
    return h('div', { class: 'component' }, String(compName(this)));
  }
  componentDidMount() {}
  componentDidUpdate(prevProps) { /* prevProps unused, kept for hook shape */ }
  componentWillUnmount() {}
  shouldComponentUpdate() {
    return true;
  }
}

// Function components are wrapped in a uniform instance so the renderer can
// treat every component the same (heavy polymorphic call sites).
class FunctionComponent {
  constructor(fn, props) {
    this.fn = fn;
    this.props = props || EMPTY_OBJ;
    this.state = EMPTY_OBJ;
    this._version = 0;
    this._poke = null;
    this._mounted = false;
    this._updates = 0;
  }
  setState(partial) {
    this.state = Object.assign({}, this.state, partial);
    this._version++;
    if (this._poke) {
      try {
        this._poke();
      } catch (e) {
        /* never throw */
      }
    }
  }
  _attachPoke(fn) {
    this._poke = fn;
  }
  render() {
    return this.fn(this.props, this);
  }
  componentDidMount() {}
  componentDidUpdate() {}
  componentWillUnmount() {}
  shouldComponentUpdate() {
    return true;
  }
}

function makeInstance(type, props) {
  if (type.prototype instanceof Component) {
    return new type(props);
  }
  return new FunctionComponent(type, props);
}

// ------------------------------------------------------------------ renderer

// Concrete node shapes produced by the renderer:
//   element:  { tag, props, children, key }
//   text:     { text }
//   comp:     { compNode, tree }
// compNode is the instance holder ({ type, key, inst, tree, phase }) reused
// across renders when type+key match, which keeps component lifecycle state.
class Renderer {
  constructor() {
    this.prev = null;
    this.live = new Set();
    this.stats = { mounts: 0, updates: 0, unmounts: 0, ops: 0 };
    this._poke = null;
  }
  attachPoke(fn) {
    this._poke = fn;
  }
  resetStats() {
    this.stats.mounts = 0;
    this.stats.updates = 0;
    this.stats.unmounts = 0;
    this.stats.ops = 0;
  }
  render(vnode) {
    const stats = this.stats;
    this.live = new Set();
    const concrete = this._build(vnode, this.prev, 1);
    if (this.prev) this._sweep(this.prev, this.live);
    const ops = [];
    if (this.prev) this._diff(this.prev, concrete, ops, 0);
    else this._mount(concrete, ops, 0);
    stats.ops += ops.length;
    this.prev = concrete;
    const parts = this._serialize(concrete, []);
    return { text: parts.join(''), ops: ops, stats: stats };
  }

  _build(vnode, prev, depth) {
    const tag = vnode.tag;
    if (typeof tag === 'string') {
      const kids = vnode.children;
      let children = null;
      if (kids && kids.length) {
        children = new Array(kids.length);
        for (let i = 0; i < kids.length; i++) {
          const k = kids[i];
          if (typeof k === 'string' || typeof k === 'number') {
            children[i] = { text: String(k) };
          } else {
            children[i] = this._build(k, null, depth + 1);
          }
        }
      }
      return {
        tag: tag,
        props: vnode.props,
        children: children,
        key: vnode.props.key != null ? String(vnode.props.key) : null,
      };
    }
    // component
    const key = vnode.props.key != null ? String(vnode.props.key) : null;
    let node = null;
    if (prev && prev.compNode && prev.compNode.type === tag && prev.compNode.key === key) {
      node = prev.compNode;
    }
    let inst;
    if (node) {
      inst = node.inst;
      const prevProps = inst.props;
      inst.props = vnode.props;
      let upd = true;
      try {
        if (typeof inst.shouldComponentUpdate === 'function') {
          upd = inst.shouldComponentUpdate(vnode.props, inst.state);
        }
      } catch (e) {
        upd = true;
      }
      if (upd && typeof inst.componentDidUpdate === 'function') {
        try {
          inst.componentDidUpdate(prevProps);
        } catch (e) {
          /* never throw */
        }
      }
      inst._updates++;
      this.stats.updates++;
      this.live.add(node);
    } else {
      node = { type: tag, key: key, inst: null, tree: null, phase: 'mounting' };
      try {
        inst = makeInstance(tag, vnode.props);
      } catch (e) {
        inst = new FunctionComponent(function () {
          return h('div', { class: 'boom' }, 'ctor-error');
        }, vnode.props);
      }
      inst._attachPoke(this._poke);
      node.inst = inst;
      this.stats.mounts++;
      this.live.add(node);
    }
    inst._attachPoke(this._poke);
    let rendered = null;
    try {
      rendered = inst.render();
    } catch (e) {
      rendered = h('div', { class: 'render-fail' }, 'render-error');
    }
    if (rendered == null) rendered = h('div', { class: 'null-render' }, 'null');
    const tree = this._build(rendered, node.tree, depth + 1);
    node.tree = tree;
    if (node.phase === 'mounting') {
      node.phase = 'mounted';
      if (typeof inst.componentDidMount === 'function') {
        try {
          inst.componentDidMount();
        } catch (e) {
          /* never throw */
        }
      }
    }
    return { compNode: node, tree: tree };
  }

  _sweep(node, live) {
    if (!node) return;
    if (node.compNode) {
      if (!live.has(node.compNode)) {
        this._unmountComp(node.compNode, live);
      } else {
        this._sweep(node.tree, live);
      }
      return;
    }
    const kids = node.children;
    if (kids) {
      for (let i = 0; i < kids.length; i++) if (kids[i]) this._sweep(kids[i], live);
    }
  }

  _unmountComp(cnode, live) {
    if (cnode.inst && typeof cnode.inst.componentWillUnmount === 'function') {
      try {
        cnode.inst.componentWillUnmount();
      } catch (e) {
        /* never throw */
      }
    }
    if (cnode.inst) cnode.inst._attachPoke(null);
    this.stats.unmounts++;
    if (cnode.tree) this._sweep(cnode.tree, live);
  }

  _mount(node, ops, depth) {
    if (!node) return;
    if (node.text !== undefined) {
      ops.push(['txt', depth, node.text]);
      return;
    }
    if (node.compNode) {
      ops.push(['cmp', depth, compName(node.compNode.inst)]);
      this._mount(node.tree, ops, depth + 1);
      return;
    }
    ops.push(['el', depth, node.tag]);
    const kids = node.children;
    if (kids) {
      for (let i = 0; i < kids.length; i++) this._mount(kids[i], ops, depth + 1);
    }
  }

  // Keyed/unkeyed virtual-DOM diff producing a compact op log. Preserves
  // instance state through component boundaries (keys + type identity).
  _diff(a, b, ops, depth) {
    if (!a || !b) {
      if (a !== b) ops.push(['r', depth]);
      return;
    }
    if (a.compNode || b.compNode) {
      if (a.compNode && b.compNode) {
        if (a.compNode.type !== b.compNode.type || a.compNode.key !== b.compNode.key) {
          ops.push(['c', depth]);
        }
        this._diff(a.tree, b.tree, ops, depth + 1);
      } else {
        ops.push(['r', depth]);
      }
      return;
    }
    if (a.text !== undefined || b.text !== undefined) {
      if (a.text !== b.text) ops.push(['t', depth, String(b.text)]);
      return;
    }
    if (a.tag !== b.tag) {
      ops.push(['r', depth]);
      return;
    }
    // attribute / text diffing (for...in over props: mixed shape sites)
    const ap = a.props || EMPTY_OBJ;
    const bp = b.props || EMPTY_OBJ;
    for (const k in bp) {
      if (k === 'key') continue;
      if (ap[k] !== bp[k]) ops.push(['attr', depth, k, String(bp[k])]);
    }
    for (const k in ap) {
      if (k === 'key' || k in bp) continue;
      ops.push(['unattr', depth, k]);
    }
    const ac = a.children;
    const bc = b.children;
    if (!ac || !bc) {
      if (ac !== bc) ops.push(['kids', depth]);
      return;
    }
    const ak = ac[0] && ac[0].key;
    const bk = bc[0] && bc[0].key;
    if (ak == null && bk == null) {
      const n = Math.min(ac.length, bc.length);
      for (let i = 0; i < n; i++) this._diff(ac[i], bc[i], ops, depth + 1);
      if (ac.length < bc.length) ops.push(['ins', depth, bc.length - ac.length]);
      else if (ac.length > bc.length) ops.push(['del', depth, ac.length - bc.length]);
    } else {
      // keyed list reconciliation
      const index = new Map();
      for (let i = 0; i < ac.length; i++) {
        const c = ac[i];
        if (c && c.key != null) index.set(c.key, i);
      }
      let lastOld = -1;
      for (let i = 0; i < bc.length; i++) {
        const c = bc[i];
        if (!c) continue;
        if (c.key == null) {
          ops.push(['ins', depth, 1]);
          continue;
        }
        const oi = index.get(c.key);
        if (oi === undefined) {
          ops.push(['ins', depth, i]);
          continue;
        }
        const oc = ac[oi];
        this._diff(oc, c, ops, depth + 1);
        if (oi < lastOld) ops.push(['mv', depth, String(c.key)]);
        if (oi > lastOld) lastOld = oi;
        index.delete(c.key);
      }
      if (index.size) ops.push(['del', depth, index.size]);
    }
  }

  _serialize(node, parts) {
    if (!node) return parts;
    if (node.text !== undefined) {
      parts.push(node.text);
      return parts;
    }
    if (node.compNode) {
      parts.push('<!--');
      parts.push(compName(node.compNode.inst));
      parts.push('-->');
      return this._serialize(node.tree, parts);
    }
    parts.push('<');
    parts.push(node.tag);
    const p = node.props || EMPTY_OBJ;
    for (const k in p) {
      if (k === 'key') continue;
      const v = p[k];
      if (v === true) {
        parts.push(' ', k);
      } else if (v === false || v == null) {
        /* skipped */
      } else {
        parts.push(' ', k, '="', String(v), '"');
      }
    }
    const kids = node.children;
    if (kids && kids.length) {
      parts.push('>');
      for (let i = 0; i < kids.length; i++) this._serialize(kids[i], parts);
      parts.push('</');
      parts.push(node.tag);
      parts.push('>');
    } else {
      parts.push('/>');
    }
    return parts;
  }
}

// --------------------------------------------------------------------- store

// Redux-like store: single state object in a signal, reducer dispatch, actions
// flow through a middleware chain, subscribers notified on commit.
class Store {
  constructor(initialState, reducer, middleware, deps) {
    this.reducer = reducer;
    this.deps = deps || EMPTY_OBJ;
    this.sig = new SignalNode(initialState, 'store');
    this.subscribers = new Set();
    this.seq = 0;
    this._undoSnap = null;
    const raw = (action) => {
      let next;
      try {
        next = this.reducer(this.sig.peek(), action);
      } catch (e) {
        next = undefined;
      }
      if (next === undefined || next === null) next = this.sig.peek();
      this.sig.set(next);
      for (const s of this.subscribers) {
        try {
          s(action, next);
        } catch (e) {
          /* never throw */
        }
      }
      return action;
    };
    this.dispatch = middleware ? middleware.reduceRight((n, mw) => mw(this)(n), raw) : raw;
  }
  getState() {
    return this.sig.get();
  }
  peekState() {
    return this.sig.peek();
  }
  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}

// Action type registry (fills ACTION_CODES for typed-array telemetry).
const ALL_TYPES = [
  'ROUTE_CHANGED', 'THEME_TOGGLE', 'LOCALE_SET', 'PLUGIN_TOGGLE', 'NAV_TOGGLE',
  'TODO_ADD', 'TODO_TOGGLE', 'TODO_REMOVE', 'TODO_EDIT', 'TODO_FILTER', 'TODO_QUERY',
  'TODO_CLEAR_DONE', 'TODO_SORT',
  'KANBAN_MOVE', 'KANBAN_ADD', 'KANBAN_ARCHIVE', 'KANBAN_LABEL', 'KANBAN_COLSORT',
  'TABLE_QUERY', 'TABLE_SORT', 'TABLE_PAGE', 'TABLE_SCROLL', 'TABLE_PAGE_SIZE',
  'NOTE_SWITCH', 'NOTE_EDIT',
  'SETTINGS_FIELD', 'SETTINGS_SUBMIT', 'SETTINGS_RESET',
  'NOTIF_ADD', 'NOTIF_DISMISS', 'NOTIF_TICK',
  'CMD_OPEN', 'CMD_QUERY', 'CMD_SELECT', 'CMD_CLOSE',
  'UNDO', 'REDO', 'NOOP', 'PERSIST_ROUNDTRIP', 'ANALYTICS_SAMPLE', 'ANALYTICS_FULL', 'BULK_AGG',
];
const ACTION_CODES = (function () {
  const m = {};
  for (let i = 0; i < ALL_TYPES.length; i++) m[ALL_TYPES[i]] = i;
  return m;
})();

const MUTATING = new Set(ALL_TYPES);
MUTATING.delete('PERSIST_ROUNDTRIP');

// --- middleware chain (applied outermost first via reduceRight below) --------

function mwAttachMeta(store) {
  return (next) => (action) => {
    const eng = store.deps.engine;
    if (eng) eng.dispatchCount++;
    const seq = store.seq++;
    return next({ type: action.type, payload: action.payload, seq: seq });
  };
}

function mwTelemetry(store) {
  return (next) => (action) => {
    const eng = store.deps.engine;
    if (eng && eng.counts) {
      const code = ACTION_CODES[action.type];
      eng.counts[(code === undefined ? 0 : code) % eng.counts.length]++;
      eng.telemetryHits++;
    }
    return next(action);
  };
}

function mwUndoable(store) {
  return (next) => (action) => {
    if (MUTATING.has(action.type)) {
      try {
        store._undoSnap = JSON.stringify(store.peekState());
      } catch (e) {
        store._undoSnap = '';
      }
    } else {
      store._undoSnap = null;
    }
    return next(action);
  };
}

function mwPersistBridge(store) {
  return (next) => (action) => {
    const eng = store.deps.engine;
    const type = action.type;
    if (type === 'PERSIST_ROUNDTRIP') {
      // full JSON persistence round-trip: serialize -> parse -> migrate
      let json = '';
      try {
        json = stableStringify(store.peekState());
      } catch (e) {
        json = '';
      }
      const restored = migrateState(parseOrNull(json));
      if (eng) {
        eng.lastPersist = {
          len: json.length,
          ok: !!(restored && restored.version === SCHEMA_VERSION),
          migr: restored ? ((restored.meta && restored.meta.migrateCount) | 0) : -1,
          t: action.payload && action.payload.t ? action.payload.t : 0,
        };
        eng.persistPokes++;
      }
    } else if (type === 'ANALYTICS_SAMPLE') {
      if (eng) {
        eng.drift(action.payload && action.payload.k ? action.payload.k : 1);
      }
    } else if (type === 'ANALYTICS_FULL') {
      if (eng) {
        eng.fullAgg();
      }
    } else if (type === 'BULK_AGG') {
      if (eng) {
        eng.bulkAgg();
      }
    }
    return next(action);
  };
}

function mwValidate(store) {
  return (next) => (action) => {
    if (!(action.type in REDUCER_TABLE) && !(action.type === 'PING')) {
      const eng = store.deps.engine;
      if (eng) eng.unknownCount++;
    }
    return next(action);
  };
}

const MIDDLEWARES = [mwAttachMeta, mwTelemetry, mwUndoable, mwPersistBridge, mwValidate];

// ------------------------------------------------------------------ selectors

// createSelector(inputs, fn): memoized selector over computed inputs.
function createSelector(inputs, fn, name) {
  const nodes = inputs.map((i) => (typeof i.get === 'function' ? i : null));
  return computed(function () {
    const args = new Array(inputs.length);
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i];
      args[i] = typeof inp.get === 'function' ? inp.get() : inp();
    }
    return fn.apply(null, args);
  }, name);
}

// ----------------------------------------------------------------- event bus

class EventBus {
  constructor() {
    this.listeners = new Map();
    this._tokens = 0;
    this.emissions = 0;
  }
  on(type, fn) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const tok = ++this._tokens;
    set.add({ tok: tok, fn: fn });
    return tok;
  }
  off(tok) {
    for (const set of this.listeners.values()) {
      for (const l of set) {
        if (l.tok === tok) {
          set.delete(l);
          return true;
        }
      }
    }
    return false;
  }
  emit(type, payload) {
    const set = this.listeners.get(type);
    if (!set) return false;
    this.emissions++;
    const arr = Array.from(set);
    for (let i = 0; i < arr.length; i++) {
      try {
        arr[i].fn(payload, type);
      } catch (e) {
        /* never throw */
      }
    }
    return true;
  }
}

// ------------------------------------------------------------------ plugins

class PluginHost {
  constructor() {
    this.plugins = [];
  }
  use(p) {
    this.plugins.push(p);
    if (typeof p.install === 'function') {
      try {
        p.install(this);
      } catch (e) {
        /* never throw */
      }
    }
  }
  hook(name) {
    const args = [];
    for (let i = 1; i < arguments.length; i++) args.push(arguments[i]);
    const out = [];
    for (let i = 0; i < this.plugins.length; i++) {
      const p = this.plugins[i];
      const fn = p[name];
      if (typeof fn === 'function') {
        try {
          const r = fn.apply(p, args);
          if (r !== undefined) out.push(r);
        } catch (e) {
          /* never throw */
        }
      }
    }
    return out;
  }
}

const telemetryPlugin = {
  name: 'telemetry',
  install() {},
  afterDispatch(ctx) {
    const eng = ctx.engine;
    eng.schedTaskCount++;
    SCHEDULER.enqueue(function () {
      eng.schedTaskCount += 2;
    }, { id: 'plug-tele', priority: 5 });
  },
};

const seoPlugin = {
  name: 'seo',
  beforeDispatch(ctx, info) {
    ctx.engine.seoTitle = 'TF:' + String(info.type).slice(0, 24);
  },
};

const footerPlugin = {
  name: 'footer',
  footer() {
    return 'plug=v' + VERSION;
  },
};

const metaPlugin = {
  name: 'postRender',
  postRender(ctx, res) {
    if (res.ops && res.ops.length === 0) ctx.engine.schedTaskCount += 1;
  },
};

// ------------------------------------------------------------------- router

function normalizePath(p) {
  let s = String(p || '/');
  if (s.charAt(0) !== '/') s = '/' + s;
  if (s.length > 1 && s.charAt(s.length - 1) === '/') s = s.slice(0, -1);
  return s;
}

function matchRoute(path) {
  const norm = normalizePath(path);
  const sp = norm === '/' ? [''] : norm.slice(1).split('/');
  for (let i = 0; i < ROUTE_TABLE.length; i++) {
    const r = ROUTE_TABLE[i];
    const rp = r.path === '/' ? [''] : r.path.slice(1).split('/');
    if (rp.length !== sp.length) continue;
    const params = {};
    let ok = true;
    for (let j = 0; j < rp.length; j++) {
      if (rp[j].charAt(0) === ':') params[rp[j].slice(1)] = sp[j];
      else if (rp[j] !== sp[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return { ok: true, route: r, params: params, path: norm };
    }
  }
  return { ok: false, path: norm };
}

function breadcrumbs(path) {
  const norm = normalizePath(path);
  if (norm === '/') return ['/'];
  const segs = norm.slice(1).split('/');
  const out = [];
  let acc = '';
  for (let i = 0; i < segs.length; i++) {
    acc += '/' + segs[i];
    out.push(acc);
  }
  return out;
}

class Router {
  constructor(ctx) {
    this.ctx = ctx;
    this.stack = ['/'];
    this.pos = 0;
    this.MAX = 40;
  }
  _go(result) {
    if (!result.ok) return false;
    this.ctx.dispatch({
      type: 'ROUTE_CHANGED',
      payload: { path: result.path, params: result.params, crumbs: breadcrumbs(result.path) },
    });
    return true;
  }
  navigate(path) {
    const m = matchRoute(path);
    if (!m.ok) return false;
    while (this.pos < this.stack.length - 1) this.stack.pop();
    this.stack.push(m.path);
    if (this.stack.length > this.MAX) this.stack.shift();
    this.pos = this.stack.length - 1;
    return this._go(m);
  }
  back() {
    if (this.pos <= 0) return false;
    this.pos--;
    return this._go(matchRoute(this.stack[this.pos]));
  }
  forward() {
    if (this.pos >= this.stack.length - 1) return false;
    this.pos++;
    return this._go(matchRoute(this.stack[this.pos]));
  }
}

// -------------------------------------------------------------- persistence

const SCHEMA_VERSION = 2;

function parseOrNull(str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
}

// Deterministic schema migration v1 -> v2 (and beyond, in order).
function migrateState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let s = raw;
  const v = s.version | 0;
  let count = 0;
  if (v < 2) {
    s = Object.assign({}, s, {
      version: 2,
      ui: Object.assign({}, s.ui, {
        navOpen: true,
        notifs: s.ui && Array.isArray(s.ui.notifs) ? s.ui.notifs : [],
      }),
      meta: Object.assign({}, s.meta, {
        count: 0, persistedLen: 0, migrateCount: (s.meta && s.meta.migrateCount ? s.meta.migrateCount : 0) + 1,
        roundtrips: 0, persistOk: 0, sampleCount: 0, fullAggs: 0, bulkAggs: 0,
      }),
    });
    count = 1;
  }
  s.__migrated = count;
  return s;
}

// --------------------------------------------------------------------- i18n

const I18N_ROWS = [
  ['app.title', 'TaskFlow', 'AufgabenFluss', 'TaskFlow'],
  ['app.subtitle', 'planning console', 'Planungskonsole', 'console de planification'],
  ['app.theme', 'theme', 'Design', 'theme'],
  ['nav.home', 'Home', 'Start', 'Accueil'],
  ['nav.todos', 'Todos', 'Aufgaben', 'Taches'],
  ['nav.kanban', 'Kanban', 'Kanban', 'Kanban'],
  ['nav.table', 'Data', 'Daten', 'Donnees'],
  ['nav.analytics', 'Analytics', 'Analysen', 'Analytique'],
  ['nav.notes', 'Notes', 'Notizen', 'Notes'],
  ['nav.settings', 'Settings', 'Einstellungen', 'Reglages'],
  ['footer.version', 'version', 'Version', 'version'],
  ['home.welcome', 'Welcome back', 'Willkommen zurueck', 'Bon retour'],
  ['home.todos', 'Open todos', 'Offene Aufgaben', 'Taches ouvertes'],
  ['home.active', 'active', 'aktiv', 'actives'],
  ['home.kanban', 'Kanban cards', 'Kanban-Karten', 'Cartes kanban'],
  ['home.cards', 'cards', 'Karten', 'cartes'],
  ['home.table', 'Table rows', 'Tabellenzeilen', 'Lignes du tableau'],
  ['home.rows', 'rows', 'Zeilen', 'lignes'],
  ['home.analytics', 'Series mean', 'Mittelwert', 'Moyenne'],
  ['home.notifs', 'Notifications', 'Benachrichtigungen', 'Notifications'],
  ['todos.title', 'Todo list', 'Aufgabenliste', 'Liste de taches'],
  ['todos.placeholder', 'What needs doing?', 'Was muss getan werden?', 'Que faire ?'],
  ['todos.all', 'All', 'Alle', 'Toutes'],
  ['todos.active', 'Active', 'Offen', 'Actives'],
  ['todos.done', 'Done', 'Erledigt', 'Terminees'],
  ['todos.meta', '{done}/{total} done, {urgent} urgent', '{done}/{total} erledigt, {urgent} dringend', '{done}/{total} terminees, {urgent} urgentes'],
  ['todos.legend', 'sorted', 'sortiert', 'tri'],
  ['kanban.title', 'Board', 'Tafel', 'Tableau'],
  ['kanban.blocked', 'blocked', 'blockiert', 'bloque'],
  ['table.title', 'Product data', 'Produktdaten', 'Donnees produits'],
  ['table.placeholder', 'Search name or category...', 'Name oder Kategorie suchen...', 'Chercher nom ou categorie...'],
  ['table.prev', 'prev', 'zurueck', 'prec'],
  ['table.next', 'next', 'weiter', 'suiv'],
  ['table.rank', 'rank', 'Rang', 'rang'],
  ['table.name', 'name', 'Name', 'nom'],
  ['table.cat', 'cat', 'Kategorie', 'categorie'],
  ['table.region', 'region', 'Region', 'region'],
  ['table.price', 'price', 'Preis', 'prix'],
  ['table.qty', 'qty', 'Menge', 'quantite'],
  ['table.score', 'score', 'Punktzahl', 'score'],
  ['notes.title', 'Documents', 'Dokumente', 'Documents'],
  ['analytics.title', 'Signal analytics', 'Signalanalysen', 'Analyse du signal'],
  ['settings.title', 'Settings', 'Einstellungen', 'Reglages'],
  ['settings.name', 'Display name', 'Anzeigename', 'Nom affiche'],
  ['settings.email', 'Email', 'E-Mail', 'Email'],
  ['settings.age', 'Age', 'Alter', 'Age'],
  ['settings.url', 'Site URL', 'Webseite', 'URL du site'],
  ['settings.bio', 'Bio', 'Bio', 'Bio'],
  ['settings.notify', 'Notify me', 'Benachrichtigen', 'Me notifier'],
  ['settings.interval', 'Refresh (min)', 'Aktualisierung (min)', 'Actualisation (min)'],
  ['settings.meta', '{filled} fields, {errs} errors', '{filled} Felder, {errs} Fehler', '{filled} champs, {errs} erreurs'],
  ['settings.submit', 'Save', 'Speichern', 'Enregistrer'],
  ['settings.saved', 'saved {n} times', '{n} mal gespeichert', 'enregistre {n} fois'],
  ['settings.errName', '3-24 characters', '3-24 Zeichen', '3-24 caracteres'],
  ['settings.errEmail', 'invalid email', 'ungueltige E-Mail', 'email invalide'],
  ['settings.errAge', '13-120', '13-120', '13-120'],
  ['settings.errUrl', 'must start with https://', 'muss mit https:// beginnen', 'doit commencer par https://'],
  ['settings.errBio', 'max 140 characters', 'max 140 Zeichen', 'max 140 caracteres'],
  ['settings.errInterval', '5-60 minutes', '5-60 Minuten', '5-60 minutes'],
  ['settings.helpName', 'public profile name', 'oeffentlicher Name', 'nom public'],
  ['settings.helpEmail', 'for receipts', 'fuer Belege', 'pour les recus'],
  ['settings.helpAge', 'numeric', 'numerisch', 'numerique'],
  ['settings.helpUrl', 'optional', 'optional', 'optionnel'],
  ['settings.helpBio', 'short intro', 'kurze Vorstellung', 'courte intro'],
  ['settings.helpInterval', 'data refresh cadence', 'Datenaktualisierung', 'cadence de donnees'],
  ['cmd.placeholder', 'Type a command...', 'Befehl eingeben...', 'Entrer une commande...'],
];

const I18N = (function () {
  const d = { en: {}, de: {}, fr: {} };
  for (let i = 0; i < I18N_ROWS.length; i++) {
    const row = I18N_ROWS[i];
    d.en[row[0]] = row[1];
    d.de[row[0]] = row[2];
    d.fr[row[0]] = row[3];
  }
  return d;
})();

// Deterministic translation lookup with {var} interpolation.
function t(ctx, key, vars) {
  const dict = ctx.selectors.localeDict.get();
  let s = dict[key];
  if (s === undefined) s = I18N.en[key] === undefined ? key : I18N.en[key];
  if (vars) {
    for (const k in vars) {
      s = s.split('{' + k + '}').join(String(vars[k]));
    }
  }
  return s;
}

// ------------------------------------------------------------------- engines

// Typed-array analytics: a drifting time series (Float64Array), histogram
// (Int32Array), online stats and linear regression. All deterministic.
class AnalyticsEngine {
  constructor() {
    this.N = 4096;
    this.buckets = 48;
    this.series = null;
    this.version = 0;
    this.tick = 0;
    this.lastStats = null;
  }
  base(i, tick) {
    const t = (i + tick) >>> 0;
    return 96 + Math.sin(t * 0.031) * 18 + Math.cos(t * 0.071) * 7 + ((Math.imul(t, 2654435761) >>> 0) % 9);
  }
  seed(rand) {
    const n = this.N;
    const s = new Float64Array(n);
    for (let i = 0; i < n; i++) s[i] = this.base(i, 0);
    this.series = s;
    this.version = 0;
    this.tick = 0;
    this.lastStats = null;
  }
  drift(k) {
    const s = this.series;
    const n = this.N;
    const kk = clamp(k | 0, 1, 64);
    for (let i = 0; i < n - kk; i++) s[i] = s[i + kk];
    this.tick = (this.tick + kk) >>> 0;
    for (let i = 0; i < kk; i++) s[n - kk + i] = this.base(n - kk + i, this.tick);
    this.version++;
  }
  compute() {
    const s = this.series;
    const n = s.length;
    let sum = 0;
    let sumSq = 0;
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = s[i];
      sum += v;
      sumSq += v * v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const mean = sum / n;
    const sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
    const hist = new Float64Array(this.buckets);
    const lo = mn;
    const span = Math.max(1e-9, mx - mn);
    for (let i = 0; i < n; i++) {
      const b = Math.min(this.buckets - 1, (((s[i] - lo) / span) * this.buckets) | 0);
      hist[b]++;
    }
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      const v = s[i];
      sx += i;
      sy += v;
      sxx += i * i;
      sxy += i * v;
    }
    const denom = n * sxx - sx * sx;
    const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
    let histSum = 0;
    for (let i = 0; i < this.buckets; i++) histSum += hist[i];
    this.lastStats = { mean: mean, sd: sd, mn: mn, mx: mx, slope: slope, histSum: histSum, hist: hist };
    this.version++;
    return this.lastStats;
  }
  peekStats() {
    if (!this.lastStats) return this.compute();
    return this.lastStats;
  }
  crc() {
    let h = 0x9e3779b9;
    const s = this.series;
    let acc = 0;
    let acc2 = 0;
    for (let i = 0; i < s.length; i++) {
      acc = (acc + Math.imul((s[i] * 67108864) | 0, i + 1)) >>> 0;
      acc2 = (acc2 + ((s[i] * 512) | 0)) >>> 0;
    }
    h = mix32(h, acc);
    h = mix32(h, acc2);
    h = mix32(h, this.version >>> 0);
    h = mix32(h, this.tick >>> 0);
    return h >>> 0;
  }
}

// Bulk typed-array aggregation workload (Int32Array + Float64Array of 64K).
class BulkEngine {
  constructor() {
    this.n = 65536;
    this.a = null;
    this.b = null;
    this.last = null;
    this.runs = 0;
  }
  seed(rand) {
    this.a = new Int32Array(this.n);
    this.b = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      this.a[i] = Math.imul(i * 1103515245 + 12345, 1 + (i & 1023)) | 0;
      this.b[i] = Math.sin(i * 0.13) * 200 + (i % 997);
    }
    this.last = null;
    this.runs = 0;
  }
  agg() {
    const a = this.a;
    const b = this.b;
    const n = this.n;
    let sumA = 0;
    let cntA = 0;
    let mxA = -2147483648;
    let mnA = 2147483647;
    const histA = new Int32Array(64);
    for (let i = 0; i < n; i++) {
      const v = a[i];
      sumA += v;
      cntA++;
      if (v > mxA) mxA = v;
      if (v < mnA) mnA = v;
      histA[(v >>> 0) % 64]++;
    }
    let sumB = 0;
    let maxB = -Infinity;
    let minB = Infinity;
    for (let i = 0; i < n; i++) {
      const v = b[i];
      sumB += v;
      if (v > maxB) maxB = v;
      if (v < minB) minB = v;
    }
    let hsum = 0;
    for (let i = 0; i < 64; i++) hsum += histA[i];
    this.last = {
      sumA: sumA >>> 0, cntA: cntA, mxA: mxA, mnA: mnA,
      sumB: sumB | 0, maxB: maxB | 0, minB: minB | 0, hsum: hsum,
    };
    this.runs++;
    return this.last;
  }
  crc() {
    const a = this.a;
    const n = a.length;
    let acc = 0;
    for (let i = 0; i < n; i += 4) acc = (acc + Math.imul(a[i], (i >>> 2) + 1)) >>> 0;
    let h = fnv1a('bulk:' + this.runs + ':' + acc);
    h = mix32(h, this.last ? this.last.sumA : 0);
    return h >>> 0;
  }
}

// Product table: parallel arrays (typed where numeric) + JS string columns.
const ADJ = ['Crimson', 'Golden', 'Silent', 'Rapid', 'Lunar', 'Solar', 'Frosted', 'Velvet', 'Amber', 'Cobalt', 'Dusky', 'Ember', 'Fractal', 'Gloomy', 'Hyper', 'Ivory', 'Jade', 'Keen', 'Lucid', 'Misty', 'Noble', 'Obscure', 'Pebble', 'Quiet', 'Rusty'];
const NOUN = ['Widget', 'Gadget', 'Module', 'Panel', 'Sensor', 'Relay', 'Hinge', 'Cable', 'Duct', 'Valve', 'Piston', 'Bracket', 'Latch', 'Motor', 'Chassis', 'Bezel', 'Plunger', 'Spindle', 'Gasket', 'Buffer', 'Rotor', 'Throttle', 'Crank', 'Fuse', 'Sprocket'];
const CATS = ['Audio', 'Video', 'Network', 'Power', 'Storage', 'Display', 'Input', 'Cooling'];
const REGIONS = ['EMEA', 'APAC', 'AMER', 'LATAM', 'NA', 'MEA', 'CIS', 'OCE'];

class TableEngine {
  constructor() {
    this.n = 0;
  }
  seed(rand, n) {
    this.n = n;
    this.names = new Array(n);
    this.cats = new Array(n);
    this.regions = new Array(n);
    this.prices = new Float64Array(n);
    this.qtys = new Int32Array(n);
    this.scores = new Float64Array(n);
    this.ranks = new Int32Array(n);
    this.ids = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const adj = ADJ[(rand() * ADJ.length) | 0];
      const noun = NOUN[(rand() * NOUN.length) | 0];
      this.names[i] = adj + ' ' + noun + ' ' + (i % 100);
      this.cats[i] = CATS[(rand() * CATS.length) | 0];
      this.regions[i] = REGIONS[(rand() * REGIONS.length) | 0];
      this.prices[i] = 4 + rand() * 996;
      this.qtys[i] = (rand() * 900) | 0;
      this.scores[i] = 0.2 + rand() * 4.8;
      this.ranks[i] = i;
      this.ids[i] = 1000 + i;
    }
  }
  filter(query) {
    const q = String(query || '').toLowerCase().trim();
    const out = [];
    const names = this.names;
    const cats = this.cats;
    if (!q) {
      for (let i = 0; i < this.n; i++) out.push(i);
      return out;
    }
    for (let i = 0; i < this.n; i++) {
      if (names[i].indexOf(q) >= 0 || cats[i].indexOf(q) >= 0) out.push(i);
    }
    return out;
  }
  sort(indices, key, dir) {
    const d = dir >= 0 ? 1 : -1;
    const arr = indices.slice();
    const cmp = KEY_COMPARATORS[key] || KEY_COMPARATORS.score;
    const e = this;
    arr.sort(function (x, y) {
      const c = cmp(e, x, y);
      return (d * c) || (x - y);
    });
    return arr;
  }
}

const KEY_COMPARATORS = {
  score: (e, x, y) => (e.scores[x] < e.scores[y] ? -1 : e.scores[x] > e.scores[y] ? 1 : 0),
  price: (e, x, y) => (e.prices[x] < e.prices[y] ? -1 : e.prices[x] > e.prices[y] ? 1 : 0),
  qty: (e, x, y) => e.qtys[x] - e.qtys[y],
  rank: (e, x, y) => e.ranks[x] - e.ranks[y],
  name: (e, x, y) => (e.names[x] < e.names[y] ? -1 : e.names[x] > e.names[y] ? 1 : 0),
};

// __PT4B__