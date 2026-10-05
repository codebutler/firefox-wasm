/* ============================================================================
 * spa.js — deterministic single-page-application workload for a bare JS engine.
 * A realistic, heavy SPA in pure ES2020: signals/computed/effects with batched
 * updates, a mini framework with function + class components (lifecycle hooks),
 * keyed virtual-DOM diff + serializer, router, redux-like store with selectors
 * and middleware, JSON persistence with schema migration, event bus, plugin
 * system, scheduler — plus feature modules (todos, kanban, virtualized table,
 * markdown docs, typed-array analytics, validated settings form, notification
 * queue, fuzzy command palette, undo/redo, i18n).
 * Every interaction flows: signal/state update -> computed/selector recompute
 * -> keyed vdom diff -> serialized output. Fully deterministic (seeded PRNG,
 * no wall clock); result() folds final state + rendered output into a 32-bit
 * FNV-1a checksum.
 * ========================================================================== */
'use strict';

/* ------------------------------ 1. primitives ----------------------------- */

/** mulberry32 seeded PRNG — deterministic across engines. */
function createRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit string checksum. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Counter-based unique id factory (order-dependent => deterministic). */
function createIdFactory(prefix) {
  let n = 0;
  return function nextId() {
    n += 1;
    return prefix + n.toString(36);
  };
}

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (ch) { return ESCAPE_MAP[ch]; });
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/** Deterministic deep clone (state stays JSON-safe by construction). */
function deepClone(value) { return JSON.parse(JSON.stringify(value)); }

/** Shallow equality for props objects. */
function propsEqual(a, b) {
  if (a === b) return true;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) if (a[ka[i]] !== b[ka[i]]) return false;
  return true;
}

/** Stable sort with an index tiebreak so output never depends on sort stability. */
function stableSort(arr, cmp) {
  const indexed = arr.map(function (v, i) { return { v: v, i: i }; });
  indexed.sort(function (x, y) {
    const c = cmp(x.v, y.v);
    return c !== 0 ? c : (x.i - y.i);
  });
  const out = new Array(arr.length);
  for (let i = 0; i < indexed.length; i++) out[i] = indexed[i].v;
  return out;
}

/** Memoizer keyed by identity of the last argument tuple. */
function memoize(fn) {
  let lastArgs = null;
  let lastResult = null;
  return function memoized() {
    const args = Array.prototype.slice.call(arguments);
    if (lastArgs !== null && lastArgs.length === args.length) {
      let same = true;
      for (let i = 0; i < args.length; i++) {
        if (lastArgs[i] !== args[i]) { same = false; break; }
      }
      if (same) return lastResult;
    }
    lastArgs = args;
    lastResult = fn.apply(null, args);
    return lastResult;
  };
}

/** Format a float deterministically. */
function dec(v, digits) { return v.toFixed(digits); }

/* ------------------------- 2. reactive core ------------------------------- */

let activeTarget = null;
let batchingDepth = 0;
const pendingEffects = new Set();

class Signal {
  constructor(initialValue) {
    this._value = initialValue;
    this.version = 0;
    this.subs = new Set(); // dependents: Computed | Effect
  }
  get value() {
    if (activeTarget !== null) activeTarget.addDep(this);
    return this._value;
  }
  set value(next) { this.set(next); }
  read() { return this.value; }
  set(next) {
    if (next === this._value) return;
    this._value = next;
    this.version += 1;
    const subs = Array.from(this.subs);
    for (let i = 0; i < subs.length; i++) subs[i].invalidate();
  }
  addDep(dep) { this.subs.add(dep); }
  removeDependent(dep) { this.subs.delete(dep); }
}

class Computed {
  constructor(fn) {
    this.fn = fn;
    this.deps = new Set();
    this.subs = new Set();
    this.dirty = true;
    this._value = undefined;
    this.version = 0;
    this._computing = false;
  }
  get value() {
    if (activeTarget !== null) activeTarget.addDep(this);
    if (this.dirty) this.recompute();
    return this._value;
  }
  read() { return this.value; }
  addDep(dep) { this.deps.add(dep); dep.subs.add(this); }
  removeDependent(dep) { this.subs.delete(dep); }
  invalidate() {
    if (this.dirty) return;
    this.dirty = true;
    const subs = Array.from(this.subs);
    for (let i = 0; i < subs.length; i++) subs[i].invalidate();
  }
  recompute() {
    if (this._computing) { this.dirty = true; return; } // circular guard
    this._computing = true;
    const prev = activeTarget;
    activeTarget = this;
    const oldDeps = this.deps;
    this.deps = new Set();
    let v;
    try {
      v = this.fn();
    } finally {
      activeTarget = prev;
      this._computing = false;
    }
    oldDeps.forEach(function (dep) {
      if (!this.deps.has(dep)) dep.removeDependent(this);
    }, this);
    this._value = v;
    this.dirty = false;
    this.version += 1;
    const subs = Array.from(this.subs);
    for (let i = 0; i < subs.length; i++) subs[i].invalidate();
  }
}

class Effect {
  constructor(fn) {
    this.fn = fn;
    this.deps = new Set();
    this.dirty = true;
    this.disposed = false;
  }
  addDep(dep) { this.deps.add(dep); dep.subs.add(this); }
  invalidate() {
    if (this.dirty || this.disposed) return;
    this.dirty = true;
    if (batchingDepth > 0) pendingEffects.add(this);
    else this.run();
  }
  run() {
    if (this.disposed) return;
    const prev = activeTarget;
    activeTarget = this;
    const oldDeps = this.deps;
    this.deps = new Set();
    try {
      this.fn();
    } finally {
      activeTarget = prev;
    }
    oldDeps.forEach(function (dep) {
      if (!this.deps.has(dep)) dep.removeDependent(this);
    }, this);
    this.dirty = false;
  }
  dispose() {
    this.disposed = true;
    const subs = Array.from(this.deps);
    for (let i = 0; i < subs.length; i++) subs[i].removeDependent(this);
    this.deps.clear();
  }
}

/** Run fn with effect invalidation coalesced until the batch ends. */
function batch(fn) {
  batchingDepth += 1;
  try {
    fn();
  } finally {
    batchingDepth -= 1;
    if (batchingDepth === 0) flushEffects();
  }
}

function flushEffects() {
  while (pendingEffects.size > 0) {
    const next = pendingEffects.values().next().value;
    pendingEffects.delete(next);
    if (!next.disposed && next.dirty) next.run();
  }
}

/** Deterministic FIFO task scheduler (drains during interaction ticks). */
class Scheduler {
  constructor() {
    this.queue = [];
    this.tickCount = 0;
  }
  schedule(fn, delayTicks) {
    this.queue.push({ run: fn, delay: delayTicks >>> 0, id: this.queue.length });
    if (this.queue.length > 64) this.queue = this.queue.slice(this.queue.length - 64);
  }
  tick() {
    this.tickCount += 1;
    const remaining = [];
    for (let i = 0; i < this.queue.length; i++) {
      const task = this.queue[i];
      if (task.delay <= 0) task.run();
      else {
        task.delay -= 1;
        remaining.push(task);
      }
    }
    this.queue = remaining;
  }
}

/* --------------------------- 3. bus + plugins ----------------------------- */

/** Topic bus with '*' wildcard listeners. */
class EventBus {
  constructor() {
    this.listeners = new Map();
    this.counters = new Map();
  }
  on(topic, fn) {
    if (!this.listeners.has(topic)) this.listeners.set(topic, []);
    this.listeners.get(topic).push({ fn: fn, once: false });
    return this;
  }
  once(topic, fn) {
    if (!this.listeners.has(topic)) this.listeners.set(topic, []);
    this.listeners.get(topic).push({ fn: fn, once: true });
    return this;
  }
  off(topic, fn) {
    const list = this.listeners.get(topic);
    if (!list) return;
    this.listeners.set(topic, list.filter(function (l) { return l.fn !== fn; }));
  }
  emit(topic, payload) {
    this.counters.set(topic, (this.counters.get(topic) || 0) + 1);
    const direct = this.listeners.get(topic);
    if (direct) {
      for (let i = 0; i < direct.length; i++) {
        const l = direct[i];
        l.fn(payload, topic);
        if (l.once) { direct.splice(i, 1); i -= 1; }
      }
    }
    const wild = this.listeners.get('*');
    if (wild) for (let i = 0; i < wild.length; i++) wild[i].fn(payload, topic);
  }
}

const PLUGIN_HOOKS = ['beforeDispatch', 'afterDispatch', 'beforeRender', 'afterRender', 'beforeAction'];
class PluginManager {
  constructor() {
    this.plugins = [];
    this.hooks = new Map();
    PLUGIN_HOOKS.forEach(function (h) { this.hooks.set(h, []); }, this);
    this.metrics = { dispatches: 0, renders: 0, actions: 0, audit: [] };
  }
  register(plugin) {
    if (!plugin || typeof plugin.name !== 'string') throw new Error('plugin needs a name');
    this.plugins.push(plugin);
    for (let i = 0; i < PLUGIN_HOOKS.length; i++) {
      const h = PLUGIN_HOOKS[i];
      if (typeof plugin[h] === 'function') this.hooks.get(h).push(plugin[h]);
    }
    return this;
  }
  run(hook, ctx) {
    const list = this.hooks.get(hook);
    if (!list) return ctx;
    for (let i = 0; i < list.length; i++) {
      const out = list[i](ctx, this.metrics);
      if (out !== undefined && out !== null && typeof out === 'object') ctx = out;
    }
    return ctx;
  }
}

/* ------------------------ 4. store + selectors ---------------------------- */

class Store {
  constructor(reducer, initialState) {
    this.reducer = reducer;
    this._state = new Signal(initialState);
    this.version = new Signal(0);
    this.middlewares = [];
    this.dispatchCount = 0;
  }
  getState() { return this._state.value; }
  getVersion() { return this.version.value; }
  use(mw) { this.middlewares.push(mw); return this; }
  dispatch(action) {
    if (!action || typeof action.type !== 'string') return null;
    let a = action;
    for (let i = 0; i < this.middlewares.length; i++) {
      const r = this.middlewares[i](a, this);
      if (r === false || r === null) return null;      // vetoed
      if (r && typeof r === 'object' && r.type) a = r; // rewritten
    }
    this.plugins.run('beforeDispatch', { action: a });
    const next = this.reducer(this._state.value, a);
    if (next !== this._state.value) {
      this._state.set(next);
      this.version.set(this.version.value + 1);
      this.dispatchCount += 1;
      this.plugins.run('afterDispatch', { action: a, state: next });
    }
    return a;
  }
  replaceState(state) {
    this._state.set(state);
    this.version.set(this.version.value + 1);
  }
}

/** Classic selector factory: memoizes the combiner on dep identities. */
function createSelector() {
  const args = Array.prototype.slice.call(arguments);
  const deps = args.slice(0, -1);
  const combiner = args[args.length - 1];
  return memoize(function () {
    const values = deps.map(function (d) { return typeof d === 'function' ? d() : d; });
    return combiner.apply(null, values);
  });
}

/* --------------------------- 5. virtual DOM ------------------------------- */

function h(tag, props, children) { return { tag: tag, props: props || {}, children: children || [] }; }
function component(type, props, key) { return { type: type, props: props || {}, key: key }; }

/** Base class component: local state + lifecycle hooks. */
class Component {
  constructor(props, ctx) {
    this.props = props;
    this.context = ctx;
    this.state = {};
    this._sig = 0;
    this.$sig = new Signal(0); // state-change signal drives re-render
  }
  setState(partial) {
    if (partial === null || typeof partial !== 'object') return;
    const keys = Object.keys(partial);
    for (let i = 0; i < keys.length; i++) this.state[keys[i]] = partial[keys[i]];
    this._sig += 1;
    this.$sig.set(this._sig);
  }
  forceUpdate() {
    this._sig += 1;
    this.$sig.set(this._sig);
  }
  render() { return h('div', { class: 'component' }, []); }
}

function sortedPropKeys(props) {
  const keys = Object.keys(props);
  keys.sort();
  return keys;
}
function propsString(props) {
  const keys = sortedPropKeys(props);
  let s = '';
  for (let i = 0; i < keys.length; i++) s += keys[i] + '="' + props[keys[i]] + '" ';
  return s;
}

/**
 * Convert a vnode into a render-tree node, resolving function/class components
 * and tracking instances by structural path+key. Signal reads during this pass
 * record the view effect's dependencies.
 */
function toVNode(v, ctx, path) {
  if (v === null || v === undefined || v === false || v === true) return null;
  if (typeof v === 'string' || typeof v === 'number') return { t: 'text', s: String(v) };
  if (Array.isArray(v)) return { t: 'frag', children: resolveChildren(v, ctx, path) };
  if (typeof v.tag === 'string') {
    return {
      t: 'el', tag: v.tag, props: v.props || {}, propsS: propsString(v.props || {}),
      children: resolveChildren(v.children || [], ctx, path), key: v.key
    };
  }
  if (typeof v.type === 'function') {
    const C = v.type;
    if (C.prototype && typeof C.prototype.render === 'function') {
      let inst = ctx.instances.get(path);
      if (!inst) {
        inst = new C(v.props, ctx);
        inst._nodePath = path;
        ctx.instances.set(path, inst);
        ctx.touched.add(path);
        inst.$sig.read();
        if (typeof inst.onMount === 'function') inst.onMount(ctx);
      } else {
        if (typeof inst.shouldUpdate === 'function' && !inst.shouldUpdate(v.props)) {
          inst.$sig.read();
          ctx.touched.add(path);
          return inst._cachedChild;
        }
        if (!propsEqual(inst.props, v.props)) {
          const prev = inst.props;
          if (typeof inst.onUpdate === 'function') inst.onUpdate(prev, v.props);
          inst.props = v.props;
        }
        inst.$sig.read();
        ctx.touched.add(path);
      }
      const inner = inst.render();
      inst._cachedChild = toVNode(inner, ctx, path + '/<' + (C.name || 'C') + '>');
      return inst._cachedChild;
    }
    return toVNode(C(v.props, ctx), ctx, path + '/<' + (C.name || 'F') + '>');
  }
  return null;
}

function resolveChildren(vnodes, ctx, path) {
  const out = [];
  let idx = 0;
  for (let i = 0; i < vnodes.length; i++) {
    const v = vnodes[i];
    if (v === null || v === undefined || v === false || v === true) continue;
    const key = (v && typeof v === 'object' && v.key !== undefined && v.key !== null) ? v.key : idx;
    const node = toVNode(v, ctx, path + '/[' + key + ']');
    if (node !== null) {
      node.key = key;
      out.push(node);
    }
    idx += 1;
  }
  return out;
}

/** In-place diff of two render-tree nodes (text/element/fragment). */
function patchNode(oldNode, newNode) {
  if (newNode === null) return null;
  if (oldNode === null) return newNode;
  if (oldNode.t !== newNode.t) return newNode;
  if (oldNode.t === 'text') {
    if (oldNode.s !== newNode.s) oldNode.s = newNode.s;
    return oldNode;
  }
  if (oldNode.t === 'frag') {
    reconcileChildren(oldNode, newNode.children || []);
    return oldNode;
  }
  if (oldNode.tag !== newNode.tag || oldNode.key !== newNode.key) return newNode;
  if (oldNode.propsS !== newNode.propsS) {
    oldNode.props = newNode.props;
    oldNode.propsS = newNode.propsS;
  }
  reconcileChildren(oldNode, newNode.children || []);
  return oldNode;
}

function sameKeyNode(a, b) { return a.key === b.key; }

/** Keyed children reconciliation (prefix/suffix scan + middle map). */
function reconcileChildren(parent, newChildren) {
  if (!parent.children) parent.children = [];
  const oldChildren = parent.children;
  const o = oldChildren.length;
  const n = newChildren.length;
  let i = 0;
  while (i < o && i < n && sameKeyNode(oldChildren[i], newChildren[i])) i += 1;
  let j = o - 1;
  let k = n - 1;
  while (j >= i && k >= i && sameKeyNode(oldChildren[j], newChildren[k])) { j -= 1; k -= 1; }
  const oldMiddleLen = j - i + 1;
  const newMiddleLen = k - i + 1;
  let middle;
  if (oldMiddleLen > 0 && newMiddleLen > 0) {
    const oldMap = new Map();
    for (let x = i; x <= j; x++) {
      if (!oldMap.has(oldChildren[x].key)) oldMap.set(oldChildren[x].key, oldChildren[x]);
    }
    middle = new Array(newMiddleLen);
    for (let x = i; x <= k; x++) {
      const nc = newChildren[x];
      const oc = oldMap.get(nc.key);
      middle[x - i] = oc ? patchNode(oc, nc) : nc;
      if (oc) oldMap.delete(nc.key);
    }
  } else {
    middle = newMiddleLen > 0 ? newChildren.slice(i, k + 1) : [];
  }
  parent.children = oldChildren.slice(0, i).concat(middle).concat(oldChildren.slice(j + 1));
}

/** Serialize a render tree to a string (the app's rendered output). */
function serializeNode(node) {
  if (node === null || node === undefined) return '';
  if (node.t === 'text') return escapeHtml(node.s);
  if (node.t === 'frag') {
    let s = '';
    const fc = node.children;
    if (fc) for (let i = 0; i < fc.length; i++) s += serializeNode(fc[i]);
    return s;
  }
  let s = '<' + node.tag;
  const props = node.props || {};
  const keys = sortedPropKeys(props);
  for (let i = 0; i < keys.length; i++) {
    s += ' ' + keys[i] + '="' + escapeHtml(String(props[keys[i]])) + '"';
  }
  s += '>';
  const c = node.children;
  if (c) for (let i = 0; i < c.length; i++) s += serializeNode(c[i]);
  return s + '</' + node.tag + '>';
}

/** Unmount instances that vanished during the latest render pass. */
function reconcileInstances(ctx) {
  const keep = new Set();
  ctx.instances.forEach(function (inst, path) {
    if (ctx.touched.has(path)) keep.add(path);
  });
  ctx.instances.forEach(function (inst, path) {
    if (!keep.has(path)) {
      if (typeof inst.onUnmount === 'function') inst.onUnmount(ctx);
      ctx.instances.delete(path);
    }
  });
}

/** Unmount everything for a view (route leave). */
function teardownView(vc) {
  vc.ctx.instances.forEach(function (inst) {
    if (typeof inst.onUnmount === 'function') inst.onUnmount(vc.ctx);
  });
  vc.ctx.instances.clear();
  vc.ctx.touched = new Set();
}

/* ------------------------------ 6. router --------------------------------- */

function compilePath(path) {
  const names = [];
  const reSrc = path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, function (m) {
    names.push(m.slice(1));
    return '([^/]+)';
  }).replace(/\*/g, '([^/]*)');
  return { path: path, names: names, re: new RegExp('^' + reSrc + '$') };
}

class Router {
  constructor(routeTable) {
    this.routes = routeTable.map(function (r) { return Object.assign({}, r, { compiled: compilePath(r.path) }); });
    this.current = new Signal({ name: 'todos', params: {}, path: '/todos' });
    this.history = [];
    this.future = [];
    this.maxHistory = 40;
  }
  find(name) {
    for (let i = 0; i < this.routes.length; i++) {
      if (this.routes[i].name === name) return this.routes[i];
    }
    return this.routes[0];
  }
  buildPath(r, params) {
    let p = r.path;
    params = params || {};
    r.compiled.names.forEach(function (n) {
      p = p.replace(':' + n, String(params[n] !== undefined ? params[n] : ''));
    });
    return p;
  }
  navigate(name, params) {
    const r = this.find(name);
    const path = this.buildPath(r, params || {});
    this.history.push(this.current.value);
    if (this.history.length > this.maxHistory) this.history.shift();
    this.future = [];
    this.current.set({ name: r.name, params: params || {}, path: path });
    return path;
  }
  navigatePath(path) {
    for (let i = 0; i < this.routes.length; i++) {
      const rc = this.routes[i].compiled;
      const m = rc.re.exec(path);
      if (m) {
        const params = {};
        for (let j = 0; j < rc.names.length; j++) params[rc.names[j]] = m[j + 1];
        return this.navigate(rc.name, params);
      }
    }
    return null;
  }
  back() {
    if (this.history.length === 0) return;
    const prev = this.history.pop();
    this.future.push(this.current.value);
    this.current.set(prev);
  }
  forward() {
    if (this.future.length === 0) return;
    const next = this.future.pop();
    this.history.push(this.current.value);
    this.current.set(next);
  }
}

/* -------------------------- 7. persistence -------------------------------- */

const SCHEMA_VERSION = 2;

/** Snapshot the app's persistable slices to a JSON string. */
function serializeState(app) {
  const st = app.store.getState();
  return JSON.stringify({
    schema: SCHEMA_VERSION,
    savedAt: 'fixed',
    state: {
      todos: st.todos, kanban: st.kanban, settings: st.settings,
      ui: { theme: st.ui.theme, lang: st.ui.lang },
      docs: st.docs, notifications: st.notifications, analytics: st.analytics
    }
  });
}

/** Migrate an older payload (schema 1) up to the current schema. */
function migratePayload(raw) {
  let out = raw;
  if (raw.schema === 1) {
    // v1 stored todos as {done:boolean}; v2 uses {status:'pending'|'done'}
    const todos = raw.state.todos.map(function (t) {
      return {
        id: t.id, text: t.text,
        status: t.done ? 'done' : 'pending',
        priority: t.priority !== undefined ? t.priority : 1,
        created: t.created
      };
    });
    out = {
      schema: 2,
      state: Object.assign({}, raw.state, {
        todos: todos,
        ui: { theme: 'light', lang: 'en' },
        docs: raw.state.docs,
        notifications: { queue: [], max: 5 }
      })
    };
  }
  if (out.schema === undefined) out.schema = SCHEMA_VERSION;
  return out.state;
}

/** Parse + migrate a persisted string back into store slices. */
function deserializeState(json) {
  return migratePayload(JSON.parse(json));
}

/** Round-trip: current state -> string -> migrated object (deterministic). */
function persistRoundTrip(app) {
  return deserializeState(serializeState(app));
}

/* ------------------------------- 8. i18n ---------------------------------- */

const I18N = {
  en: {
    appTitle: 'Workspace',
    nav: { todos: 'Tasks', kanban: 'Board', table: 'Data', docs: 'Docs', analytics: 'Analytics', settings: 'Settings' },
    todos: { title: 'Tasks', addPlaceholder: 'What needs doing?', add: 'Add', remaining: '{count} remaining', all: 'All', active: 'Active', done: 'Done', clearDone: 'Clear completed', toggleAll: 'Toggle all' },
    kanban: { title: 'Board', add: 'Add card', move: 'Move' },
    table: { title: 'Data Table', search: 'Search…', rows: '{count} rows', prev: 'Prev', next: 'Next' },
    docs: { title: 'Documentation', words: '{count} words' },
    analytics: { title: 'Analytics', sum: 'sum {v}', mean: 'mean {v}' },
    settings: { title: 'Settings', username: 'Username', email: 'Email', bio: 'Bio', difficulty: 'Difficulty', newsletter: 'Newsletter', save: 'Save', reset: 'Reset', valid: 'All fields valid', invalid: 'Please fix {n} error(s)' },
    notify: { title: 'Notifications', clear: 'Clear all' },
    palette: { title: 'Command palette', hint: 'Type a command…' },
    status: { ops: '{count} operations', route: 'route {name}' }
  },
  de: {
    appTitle: 'Arbeitsbereich',
    nav: { todos: 'Aufgaben', kanban: 'Tafel', table: 'Daten', docs: 'Doku', analytics: 'Analysen', settings: 'Einstellungen' },
    todos: { title: 'Aufgaben', addPlaceholder: 'Was ist zu tun?', add: 'Hinzufügen', remaining: '{count} offen', all: 'Alle', active: 'Offen', done: 'Erledigt', clearDone: 'Erledigte löschen', toggleAll: 'Alle umschalten' },
    kanban: { title: 'Tafel', add: 'Karte hinzufügen', move: 'Verschieben' },
    table: { title: 'Datentabelle', search: 'Suchen…', rows: '{count} Zeilen', prev: 'Zurück', next: 'Weiter' },
    docs: { title: 'Dokumentation', words: '{count} Wörter' },
    analytics: { title: 'Analysen', sum: 'Summe {v}', mean: 'Mittel {v}' },
    settings: { title: 'Einstellungen', username: 'Benutzername', email: 'E-Mail', bio: 'Bio', difficulty: 'Schwierigkeit', newsletter: 'Newsletter', save: 'Speichern', reset: 'Zurücksetzen', valid: 'Alle Felder gültig', invalid: 'Bitte {n} Fehler beheben' },
    notify: { title: 'Benachrichtigungen', clear: 'Alle löschen' },
    palette: { title: 'Befehlspalette', hint: 'Befehl eingeben…' },
    status: { ops: '{count} Vorgänge', route: 'Route {name}' }
  },
  es: {
    appTitle: 'Espacio de trabajo',
    nav: { todos: 'Tareas', kanban: 'Tablero', table: 'Datos', docs: 'Docs', analytics: 'Analítica', settings: 'Ajustes' },
    todos: { title: 'Tareas', addPlaceholder: '¿Qué hay que hacer?', add: 'Añadir', remaining: '{count} pendientes', all: 'Todas', active: 'Activas', done: 'Hechas', clearDone: 'Borrar hechas', toggleAll: 'Cambiar todas' },
    kanban: { title: 'Tablero', add: 'Añadir tarjeta', move: 'Mover' },
    table: { title: 'Tabla de datos', search: 'Buscar…', rows: '{count} filas', prev: 'Anterior', next: 'Siguiente' },
    docs: { title: 'Documentación', words: '{count} palabras' },
    analytics: { title: 'Analítica', sum: 'suma {v}', mean: 'media {v}' },
    settings: { title: 'Ajustes', username: 'Usuario', email: 'Correo', bio: 'Bio', difficulty: 'Dificultad', newsletter: 'Boletín', save: 'Guardar', reset: 'Restablecer', valid: 'Todo válido', invalid: 'Corrige {n} error(es)' },
    notify: { title: 'Notificaciones', clear: 'Borrar todo' },
    palette: { title: 'Paleta de comandos', hint: 'Escribe un comando…' },
    status: { ops: '{count} operaciones', route: 'ruta {name}' }
  }
};

function translate(lang, key, vars) {
  let cur = I18N[lang] || I18N.en;
  const parts = key.split('.');
  for (let i = 0; i < parts.length && cur !== undefined; i++) cur = cur[parts[i]];
  if (cur === undefined || cur === null) {
    cur = I18N.en;
    const fb = key.split('.');
    for (let i = 0; i < fb.length && cur !== undefined; i++) cur = cur[fb[i]];
  }
  let out = String(cur === undefined ? key : cur);
  if (vars) {
    out = out.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, function (m, name) {
      return vars[name] !== undefined ? String(vars[name]) : m;
    });
  }
  return out;
}

/* ------------------------- 9. feature modules ----------------------------- */

const todoNewId = createIdFactory('td');
function todosReducer(slice, action) {
  switch (action.type) {
    case 'todos/add': {
      const item = { id: action.id, text: action.text, status: 'pending', priority: action.priority, created: action.created };
      let items = slice.items.concat([item]);
      if (items.length > 45) items = items.slice(items.length - 45);
      return Object.assign({}, slice, { items: items });
    }
    case 'todos/toggle': {
      const items = slice.items.map(function (t) {
        return t.id !== action.id ? t
          : { id: t.id, text: t.text, status: t.status === 'done' ? 'pending' : 'done', priority: t.priority, created: t.created };
      });
      return Object.assign({}, slice, { items: items });
    }
    case 'todos/edit':
      return Object.assign({}, slice, {
        items: slice.items.map(function (t) {
          return t.id !== action.id ? t : { id: t.id, text: action.text, status: t.status, priority: t.priority, created: t.created };
        })
      });
    case 'todos/remove':
      return Object.assign({}, slice, { items: slice.items.filter(function (t) { return t.id !== action.id; }) });
    case 'todos/filter':
      return Object.assign({}, slice, { filter: action.filter });
    case 'todos/toggleAll': {
      const allDone = slice.items.length > 0 && slice.items.every(function (t) { return t.status === 'done'; });
      const next = allDone ? 'pending' : 'done';
      return Object.assign({}, slice, {
        items: slice.items.map(function (t) {
          return { id: t.id, text: t.text, status: next, priority: t.priority, created: t.created };
        })
      });
    }
    case 'todos/clearDone':
      return Object.assign({}, slice, { items: slice.items.filter(function (t) { return t.status !== 'done'; }) });
    case 'todos/replace':
      return action.snapshot;
    default:
      return slice;
  }
}

function visibleTodos(todos, filter) {
  if (filter === 'active') return todos.filter(function (t) { return t.status !== 'done'; });
  if (filter === 'done') return todos.filter(function (t) { return t.status === 'done'; });
  return todos;
}

function todoStats(todos) {
  let done = 0;
  for (let i = 0; i < todos.length; i++) if (todos[i].status === 'done') done += 1;
  return { total: todos.length, done: done, remaining: todos.length - done };
}

const kanbanColId = createIdFactory('col');
const kanbanCardId = createIdFactory('card');
function kanbanReducer(slice, action) {
  switch (action.type) {
    case 'kanban/add': {
      const columns = slice.columns.map(function (c) {
        if (c.id !== action.columnId) return c;
        let items = c.items.concat([{ id: action.cardId, text: action.text, tag: action.tag }]);
        if (items.length > 40) items = items.slice(items.length - 40);
        return Object.assign({}, c, { items: items });
      });
      return Object.assign({}, slice, { columns: columns });
    }
    case 'kanban/move': {
      const columns = slice.columns.map(function (c) {
        const items = c.items.filter(function (card) { return card.id !== action.cardId; });
        return items.length === c.items.length ? c : Object.assign({}, c, { items: items });
      });
      const target = columns.find(function (c) { return c.id === action.toColumnId; });
      if (!target) return slice;
      const source = slice.columns.find(function (c) {
        return c.items.some(function (card) { return card.id === action.cardId; });
      });
      const card = source ? source.items.find(function (c2) { return c2.id === action.cardId; }) : null;
      if (!card) return slice;
      return Object.assign({}, slice, {
        columns: columns.map(function (c) {
          return c.id !== action.toColumnId ? c : Object.assign({}, c, { items: c.items.concat([card]) });
        })
      });
    }
    case 'kanban/remove': {
      const columns = slice.columns.map(function (c) {
        const items = c.items.filter(function (card) { return card.id !== action.cardId; });
        return items.length === c.items.length ? c : Object.assign({}, c, { items: items });
      });
      return Object.assign({}, slice, { columns: columns });
    }
    case 'kanban/rename': {
      const columns = slice.columns.map(function (c) {
        return c.id !== action.columnId ? c : Object.assign({}, c, { title: action.title });
      });
      return Object.assign({}, slice, { columns: columns });
    }
    default:
      return slice;
  }
}

function kanbanCounts(slice) {
  let total = 0;
  for (let i = 0; i < slice.columns.length; i++) total += slice.columns[i].items.length;
  return total;
}

// Rows are plain objects; parallel typed arrays (aligned by index) back the
// numeric columns so aggregations run over typed arrays.
const ROW_FIRST = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron', 'Pi', 'Rho', 'Sigma', 'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega'];
const ROW_CATS = ['widget', 'gadget', 'sprocket', 'flange', 'cog', 'bearing', 'washer', 'gear'];
function generateRows(rng, count) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      id: 'row' + i,
      name: ROW_FIRST[i % ROW_FIRST.length] + ' ' + (Math.floor(rng() * 900) + 1),
      category: ROW_CATS[i % ROW_CATS.length],
      price: Math.round(rng() * 100000) / 1000,
      qty: Math.floor(rng() * 900),
      score: Math.round(rng() * 10000) / 100
    });
  }
  return rows;
}

function tableReducer(slice, action) {
  switch (action.type) {
    case 'table/sort': return Object.assign({}, slice, { sort: action.sort });
    case 'table/query': return Object.assign({}, slice, { query: action.query, page: 0 });
    case 'table/page': return Object.assign({}, slice, { page: clamp(action.page, 0, 9999) });
    case 'table/pageSize': return Object.assign({}, slice, { pageSize: action.size, page: 0 });
    case 'table/scroll': return Object.assign({}, slice, { scrollTop: clamp(action.scrollTop, 0, 1e7) });
    case 'table/replace': return Object.assign({}, slice, { rows: action.rows, page: 0, scrollTop: 0 });
    default: return slice;
  }
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function filterRows(rows, query) {
  if (!query) return rows;
  const rx = new RegExp(escapeRegExp(query), 'i');
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (rx.test(rows[i].name) || rx.test(rows[i].category)) out.push(rows[i]);
  }
  return out;
}
function sortRows(rows, sort) {
  if (!sort || !sort.col) return rows;
  const dir = sort.dir;
  return stableSort(rows, function (a, b) {
    const av = a[sort.col];
    const bv = b[sort.col];
    return av < bv ? -dir : (av > bv ? dir : 0);
  });
}
function applyTablePipeline(rows, query, sort) {
  const filtered = filterRows(rows, query);
  return { filtered: filtered, sorted: sortRows(filtered, sort) };
}
function sumVisible(prices, quantities, scores, visible) {
  let p = 0, q = 0, s = 0;
  for (let i = 0; i < visible.length; i++) {
    const idx = visible[i];
    p += prices[idx];
    q += quantities[idx];
    s += scores[idx];
  }
  return { p: p, q: q, s: s };
}

/** Markdown-ish inline parser: **bold**, *italic*, `code`, [label](url). */
function renderInline(text) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.charAt(0) === '*' && tok.charAt(1) === '*') out.push(h('strong', { class: 'md-bold' }, [tok.slice(2, -2)]));
    else if (tok.charAt(0) === '*') out.push(h('em', { class: 'md-italic' }, [tok.slice(1, -1)]));
    else if (tok.charAt(0) === '`') out.push(h('code', { class: 'md-code' }, [tok.slice(1, -1)]));
    else {
      const inner = tok.slice(1, -1);
      const close = inner.lastIndexOf('](');
      out.push(h('a', { class: 'md-link', href: inner.slice(close + 2, -1) }, [inner.slice(0, close)]));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function parseMarkdown(src) {
  const nodes = [];
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i += 1; }
      i += 1;
      nodes.push(h('pre', { class: 'md-codeblock' }, [code.join('\n')]));
      continue;
    }
    const hMatch = /^(#{1,3})\s+(.*)$/.exec(line);
    if (hMatch) {
      nodes.push(h('h' + hMatch[1].length, { class: 'md-heading' }, renderInline(hMatch[2])));
      i += 1;
      continue;
    }
    const qMatch = /^>\s?(.*)$/.exec(line);
    if (qMatch) {
      nodes.push(h('blockquote', { class: 'md-quote' }, renderInline(qMatch[1])));
      i += 1;
      continue;
    }
    const listMatch = /^[-*]\s+(.*)$/.exec(line);
    if (listMatch) {
      const items = [];
      while (i < lines.length) {
        const lm = /^[-*]\s+(.*)$/.exec(lines[i]);
        if (!lm) break;
        items.push(h('li', { class: 'md-li' }, renderInline(lm[1])));
        i += 1;
      }
      nodes.push(h('ul', { class: 'md-ul' }, items));
      continue;
    }
    const numMatch = /^(\d+)\.\s+(.*)$/.exec(line);
    if (numMatch) {
      const items = [];
      while (i < lines.length) {
        const nm = /^(\d+)\.\s+(.*)$/.exec(lines[i]);
        if (!nm) break;
        items.push(h('li', { class: 'md-li' }, renderInline(nm[2])));
        i += 1;
      }
      nodes.push(h('ol', { class: 'md-ol' }, items));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,3}|>|[-*]|\d+\.|```)/.test(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    if (para.length > 0) nodes.push(h('p', { class: 'md-p' }, renderInline(para.join(' '))));
    else i += 1;
  }
  return nodes;
}

function docsReducer(slice, action) {
  switch (action.type) {
    case 'docs/insert':
      return Object.assign({}, slice, { src: slice.src.slice(0, action.at) + action.text + slice.src.slice(action.at), cursor: action.at + action.text.length });
    case 'docs/delete':
      if (slice.src.length === 0) return slice;
      return Object.assign({}, slice, { src: slice.src.slice(0, slice.src.length - 1), cursor: Math.max(0, slice.cursor - 1) });
    case 'docs/replace':
      return Object.assign({}, slice, { src: action.src });
    default:
      return slice;
  }
}

function countWords(src) {
  const m = src.match(/[A-Za-z0-9_-]+/g);
  return m ? m.length : 0;
}

/** Analytics datasets as Float64Array columns. */
function buildDatasets(rng) {
  const datasets = [];
  const sizes = [2000, 4000, 8000];
  for (let d = 0; d < sizes.length; d++) {
    const n = sizes[d];
    const values = new Float64Array(n);
    const latencies = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      values[i] = Math.round((50 + Math.sin(i * 0.0023) * 20 + rng() * 40) * 100) / 100;
      latencies[i] = Math.round((12 + rng() * 88) * 100) / 100;
    }
    datasets.push({ name: 'series' + d, size: n, values: values, latencies: latencies });
  }
  return datasets;
}

function analyzeSeries(values, bins) {
  const n = values.length;
  let sum = 0, sumSq = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    sum += v;
    sumSq += v * v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = n > 0 ? sum / n : 0;
  const variance = n > 0 ? Math.max(0, sumSq / n - mean * mean) : 0;
  const span = max - min;
  const hist = new Int32Array(bins);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    const idx = span > 0 ? Math.min(bins - 1, Math.max(0, Math.floor(((v - min) / span) * bins))) : 0;
    hist[idx] += 1;
  }
  const cum = new Int32Array(bins);
  let acc = 0;
  for (let i = 0; i < bins; i++) { acc += hist[i]; cum[i] = acc; }
  const p = function (frac) {
    if (n === 0) return 0;
    const target = frac * n;
    for (let i = 0; i < bins; i++) {
      if (cum[i] >= target) return min + ((i + 0.5) / bins) * span;
    }
    return max;
  };
  return {
    n: n, sum: sum, mean: mean, min: min, max: max, variance: variance, std: Math.sqrt(variance),
    p50: p(0.5), p90: p(0.9), p99: p(0.99), hist: Array.prototype.slice.call(hist)
  };
}

function aggregateDatasets(datasets, datasetIndex, bins) {
  const ds = datasets[datasetIndex];
  return { dataset: ds.name, size: ds.size, values: analyzeSeries(ds.values, bins), latencies: analyzeSeries(ds.latencies, 16) };
}

function analyticsReducer(slice, action) {
  switch (action.type) {
    case 'analytics/timeframe': return Object.assign({}, slice, { timeframe: action.timeframe });
    case 'analytics/dataset': return Object.assign({}, slice, { dataset: action.dataset });
    case 'analytics/refresh': return Object.assign({}, slice, { aggTick: slice.aggTick + 1, results: action.results });
    default: return slice;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[A-Za-z0-9_.]{3,24}$/;
const BIO_MAX = 140;
function validateSettings(st) {
  const errors = {};
  if (!USERNAME_RE.test(st.username || '')) errors.username = 'username must be 3-24 chars [A-Za-z0-9_.]';
  if (!EMAIL_RE.test(st.email || '')) errors.email = 'email is not valid';
  const bioLen = (st.bio || '').length;
  if (bioLen > BIO_MAX) errors.bio = 'bio too long (' + bioLen + '/' + BIO_MAX + ')';
  const d = Number(st.difficulty);
  if (!(d >= 1 && d <= 5 && Math.floor(d) === d)) errors.difficulty = 'difficulty must be an integer 1-5';
  return errors;
}
function settingsReducer(slice, action) {
  switch (action.type) {
    case 'settings/field': {
      const field = {};
      field[action.field] = action.value;
      return Object.assign({}, slice, field);
    }
    case 'settings/touch':
      return Object.assign({}, slice, { touched: Object.assign({}, slice.touched, action.touched) });
    case 'settings/reset':
      return Object.assign({}, slice, { username: '', email: '', bio: '', difficulty: 1, newsletter: false, touched: {}, saved: false });
    case 'settings/saved':
      return Object.assign({}, slice, { saved: true, savedAt: slice.savedAt + 1 });
    default:
      return slice;
  }
}

const notifyId = createIdFactory('nt');
function notificationsReducer(slice, action) {
  switch (action.type) {
    case 'notify/push': {
      let queue = slice.queue.concat([{ id: action.id, kind: action.kind, msg: action.msg, age: 0, ttl: action.ttl }]);
      if (queue.length > slice.max) queue = queue.slice(queue.length - slice.max);
      return Object.assign({}, slice, { queue: queue });
    }
    case 'notify/tick':
      return Object.assign({}, slice, {
        queue: slice.queue.map(function (n) { return Object.assign({}, n, { age: n.age + 1 }); })
          .filter(function (n) { return n.age <= n.ttl; })
      });
    case 'notify/dismiss':
      return Object.assign({}, slice, { queue: slice.queue.filter(function (n) { return n.id !== action.id; }) });
    case 'notify/clear':
      return Object.assign({}, slice, { queue: [] });
    default:
      return slice;
  }
}

/** Subsequence fuzzy match score; -1 when no match. */
function fuzzyScore(query, text) {
  if (!query) return 1000;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0, score = 0, prevMatch = -2, consecutive = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t.charAt(ti) === q.charAt(qi)) {
      if (ti === prevMatch + 1) consecutive += 4;
      else consecutive = 1;
      score += 20 - ti * 0.35 + consecutive;
      prevMatch = ti;
      qi += 1;
    }
  }
  return qi === q.length ? score : -1;
}

function searchCommands(commands, query) {
  if (!query) return commands.map(function (c, i) { return { cmd: c, score: 1000 - i, idx: i }; });
  const scored = [];
  for (let i = 0; i < commands.length; i++) {
    const s = fuzzyScore(query, commands[i].title);
    if (s >= 0) scored.push({ cmd: commands[i], score: s, idx: i });
  }
  scored.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return a.idx - b.idx;
  });
  return scored;
}

function paletteReducer(slice, action) {
  switch (action.type) {
    case 'palette/open': return Object.assign({}, slice, { open: true, query: '', index: 0 });
    case 'palette/close': return Object.assign({}, slice, { open: false, query: '', index: 0 });
    case 'palette/query': return Object.assign({}, slice, { query: action.query, index: 0 });
    case 'palette/move': return Object.assign({}, slice, { index: Math.max(0, slice.index + action.delta) });
    default: return slice;
  }
}

const HISTORY_LIMIT = 80;
function historyReducer(slice, action) {
  switch (action.type) {
    case 'history/push': {
      let past = slice.past.concat([action.snapshot]);
      if (past.length > HISTORY_LIMIT) past = past.slice(past.length - HISTORY_LIMIT);
      return { past: past, future: [] };
    }
    case 'history/undo': {
      if (slice.past.length === 0) return slice;
      const past = slice.past.slice(0, -1);
      const future = slice.future.concat([slice.past[slice.past.length - 1]]);
      return { past: past, future: future };
    }
    case 'history/redo': {
      if (slice.future.length === 0) return slice;
      const snapshot = slice.future[slice.future.length - 1];
      return { past: slice.past.concat([snapshot]), future: slice.future.slice(0, -1) };
    }
    default:
      return slice;
  }
}

/* -------------------------- 10. app assembly ------------------------------ */

const INITIAL_STATE = {
  ui: { theme: 'light', lang: 'en', paletteOpen: false, paletteQuery: '', paletteIndex: 0, sidebarCollapsed: false },
  todos: { items: [], filter: 'all' },
  kanban: { columns: [
    { id: 'col-backlog', title: 'Backlog', items: [] },
    { id: 'col-doing', title: 'Doing', items: [] },
    { id: 'col-done', title: 'Done', items: [] }
  ], board: 'main' },
  table: { rows: [], sort: { col: 'name', dir: 1 }, query: '', page: 0, pageSize: 20, scrollTop: 0 },
  docs: { src: '', cursor: 0 },
  analytics: { timeframe: 'week', dataset: 0, aggTick: 0, results: null },
  settings: { username: '', email: '', bio: '', difficulty: 1, newsletter: false, touched: {}, saved: false, savedAt: 0 },
  notifications: { queue: [], max: 5 },
  history: { past: [], future: [] },
  meta: { opCount: 0 }
};

function rootReducer(state, action) {
  switch (action.type) {
    case 'todos/add': case 'todos/toggle': case 'todos/edit': case 'todos/remove':
    case 'todos/filter': case 'todos/toggleAll': case 'todos/clearDone': case 'todos/replace':
      return Object.assign({}, state, { todos: todosReducer(state.todos, action) });
    case 'kanban/add': case 'kanban/move': case 'kanban/remove': case 'kanban/rename':
      return Object.assign({}, state, { kanban: kanbanReducer(state.kanban, action) });
    case 'table/sort': case 'table/query': case 'table/page': case 'table/pageSize':
    case 'table/scroll': case 'table/replace':
      return Object.assign({}, state, { table: tableReducer(state.table, action) });
    case 'docs/insert': case 'docs/delete': case 'docs/replace':
      return Object.assign({}, state, { docs: docsReducer(state.docs, action) });
    case 'analytics/timeframe': case 'analytics/dataset': case 'analytics/refresh':
      return Object.assign({}, state, { analytics: analyticsReducer(state.analytics, action) });
    case 'settings/field': case 'settings/touch': case 'settings/reset': case 'settings/saved':
      return Object.assign({}, state, { settings: settingsReducer(state.settings, action) });
    case 'notify/push': case 'notify/tick': case 'notify/dismiss': case 'notify/clear':
      return Object.assign({}, state, { notifications: notificationsReducer(state.notifications, action) });
    case 'palette/open': case 'palette/close': case 'palette/query': case 'palette/move':
      return Object.assign({}, state, { ui: Object.assign({}, state.ui, paletteReducer(state.ui, action)) });
    case 'ui/theme':
      return Object.assign({}, state, { ui: Object.assign({}, state.ui, { theme: action.theme }) });
    case 'ui/lang':
      return Object.assign({}, state, { ui: Object.assign({}, state.ui, { lang: action.lang }) });
    case 'ui/sidebar':
      return Object.assign({}, state, { ui: Object.assign({}, state.ui, { sidebarCollapsed: action.collapsed }) });
    case 'history/push': case 'history/undo': case 'history/redo':
      return Object.assign({}, state, { history: historyReducer(state.history, action) });
    case 'meta/tick':
      return Object.assign({}, state, { meta: { opCount: action.count } });
    case 'state/restore':
      return action.state;
    default:
      return state;
  }
}

function createApp() {
  const rng = createRng(0x5EED);
  const app = {
    rng: rng, store: null, router: null,
    bus: new EventBus(), plugins: new PluginManager(), scheduler: new Scheduler(),
    uiTick: new Signal(0), totals: null, datasets: buildDatasets(rng),
    views: {}, activeView: null, viewEffect: null, lastHtml: ''
  };

  const initialState = deepClone(INITIAL_STATE);

  const seedTodos = [
    'Ship the wasm shell build', 'Review interpreter fallback paths', 'Benchmark JIT vs baseline',
    'Write migration for schema v1', 'Polish command palette fuzzy match', 'Add virtual window overscan',
    'Tune histogram binning', 'Document the reactive core', 'Wire i18n dictionaries',
    'Compact undo history', 'Fix keyed list reconciliation', 'Audit typed array aggregations'
  ];
  for (let i = 0; i < seedTodos.length; i++) {
    initialState.todos.items.push({
      id: todoNewId(), text: seedTodos[i], status: i % 4 === 0 ? 'done' : 'pending',
      priority: (i % 3) + 1, created: i
    });
  }

  const seedCards = [
    ['Design signal graph', 'col-backlog', 'core'], ['Keyed diff prototype', 'col-backlog', 'core'],
    ['Router param matching', 'col-doing', 'core'], ['Table virtualization', 'col-doing', 'ui'],
    ['Aggregate histogram', 'col-done', 'perf'], ['Notification TTL', 'col-done', 'ui']
  ];
  for (let i = 0; i < seedCards.length; i++) {
    const col = initialState.kanban.columns.find(function (c) { return c.id === seedCards[i][1]; });
    col.items.push({ id: kanbanCardId(), text: seedCards[i][0], tag: seedCards[i][2] });
  }

  const rows = generateRows(rng, 256);
  initialState.table.rows = rows;
  app.prices = new Float64Array(rows.length);
  app.quantities = new Int32Array(rows.length);
  app.scores = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    app.prices[i] = rows[i].price;
    app.quantities[i] = rows[i].qty;
    app.scores[i] = rows[i].score;
  }

  initialState.docs.src = [
    '# Welcome to the Workspace',
    '',
    'This is **markdown** with `inline code`, a *little* emphasis and a [link](https://example.test).',
    '',
    '## Reactive core',
    '',
    '- signals with versioned dependency graph',
    '- computed selectors with memoization',
    '- batched effects through the scheduler queue',
    '',
    '1. dispatch actions to the store',
    '2. middleware chain transforms actions',
    '3. reducer produces a new immutable state',
    '',
    '> The keyed reconciliation keeps list identity stable.',
    '',
    '```js',
    'const view = computed(() => render(route, state));',
    'effect(() => { patch(tree, view.value); });',
    '```',
    '',
    '### Typed array analytics',
    '',
    'Histograms, quantiles and streaming aggregates are computed over **Float64Array**',
    'columns aligned to the table rows.'
  ].join('\n');
  initialState.docs.cursor = 0;

  // store + middleware + plugins
  const store = new Store(rootReducer, initialState);
  app.store = store;
  store.use(function auditMiddleware(action, st) { app.plugins.metrics.actions += 1; return action; });
  store.use(function vetoDebugMiddleware(action) {
    return action.type.indexOf('debug') === 0 ? false : action; // veto stray debug actions
  });
  store.plugins = app.plugins;

  app.plugins.register({
    name: 'core-metrics',
    beforeDispatch: function (ctx, m) { m.dispatches += 1; return ctx; },
    afterDispatch: function (ctx, m) {
      m.audit.push(ctx.action.type);
      if (m.audit.length > 200) m.audit = m.audit.slice(m.audit.length - 200);
      return ctx;
    },
    beforeRender: function (ctx, m) { m.renders += 1; return ctx; },
    afterRender: function (ctx) { return ctx; },
    beforeAction: function (ctx) { return ctx; }
  });
  app.plugins.register({ name: 'theme-guard', beforeAction: function (ctx) { return ctx; } });

  // router
  const router = new Router([
    { name: 'todos', path: '/todos', view: 'todos', title: 'Tasks' },
    { name: 'todos-active', path: '/todos/:filter', view: 'todos', title: 'Tasks (filtered)' },
    { name: 'kanban', path: '/kanban', view: 'kanban', title: 'Board' },
    { name: 'table', path: '/table', view: 'table', title: 'Data' },
    { name: 'table-page', path: '/table/page/:page', view: 'table', title: 'Data (page)' },
    { name: 'docs', path: '/docs', view: 'docs', title: 'Docs' },
    { name: 'analytics', path: '/analytics', view: 'analytics', title: 'Analytics' },
    { name: 'settings', path: '/settings', view: 'settings', title: 'Settings' }
  ]);
  app.router = router;

  // event bus wiring (deterministic listeners)
  const busCounters = { userActivity: 0, todosChanged: 0, viewChanged: 0, notifyPushed: 0, aggregateRun: 0 };
  app.busCounters = busCounters;
  app.bus.on('user:activity', function (p) { busCounters.userActivity += 1; app.bus.lastActivity = p; });
  app.bus.on('todos:change', function () { busCounters.todosChanged += 1; });
  app.bus.on('view:change', function (p) { busCounters.viewChanged += 1; app.bus.lastView = p; });
  app.bus.on('notify:push', function () { busCounters.notifyPushed += 1; });
  app.bus.on('aggregate:run', function () { busCounters.aggregateRun += 1; });
  app.bus.on('*', function (p, t) { app.bus.lastWild = { p: p, t: t }; });

  const paletteCommands = [
    { id: 'nav-todos', title: 'Go to Tasks', run: function () { router.navigate('todos'); } },
    { id: 'nav-kanban', title: 'Open Kanban board', run: function () { router.navigate('kanban'); } },
    { id: 'nav-table', title: 'Open data table', run: function () { router.navigate('table'); } },
    { id: 'nav-docs', title: 'Open documentation', run: function () { router.navigate('docs'); } },
    { id: 'nav-analytics', title: 'Open analytics', run: function () { router.navigate('analytics'); } },
    { id: 'nav-settings', title: 'Open settings', run: function () { router.navigate('settings'); } },
    { id: 'theme-toggle', title: 'Toggle theme', run: function () {
      store.dispatch({ type: 'ui/theme', theme: store.getState().ui.theme === 'light' ? 'dark' : 'light' });
    } },
    { id: 'lang-de', title: 'Switch language (DE)', run: function () {
      store.dispatch({ type: 'ui/lang', lang: store.getState().ui.lang === 'de' ? 'en' : 'de' });
    } },
    { id: 'notify-clear', title: 'Clear notifications', run: function () { store.dispatch({ type: 'notify/clear' }); } },
    { id: 'undo', title: 'Undo last change', run: function () { app.undoTodos(); } },
    { id: 'redo', title: 'Redo last change', run: function () { app.redoTodos(); } },
    { id: 'doc-italic', title: 'Insert italic marker', run: function () {
      store.dispatch({ type: 'docs/insert', at: store.getState().docs.src.length, text: '*__*' });
    } }
  ];
  app.paletteCommands = paletteCommands;

  // stable action callbacks for components
  const actions = {
    toggleTodo: function (id) { store.dispatch({ type: 'todos/toggle', id: id }); },
    editTodo: function (id, text) { store.dispatch({ type: 'todos/edit', id: id, text: text }); },
    removeTodo: function (id) { store.dispatch({ type: 'todos/remove', id: id }); },
    sortTable: function (col, dir) { store.dispatch({ type: 'table/sort', sort: { col: col, dir: dir } }); },
    notify: function (msg, kind) { app.pushNotification(msg, kind, 3); }
  };
  app.actions = actions;

  app.pushNotification = function (msg, kind, ttl) {
    const id = notifyId();
    store.dispatch({ type: 'notify/push', id: id, kind: kind, msg: msg, ttl: ttl });
    app.scheduler.schedule(function () { // auto-dismiss after a few ticks
      store.dispatch({ type: 'notify/dismiss', id: id });
    }, ttl);
  };

  // undo/redo helpers over the todos slice
  app.snapshotTodos = function () { return deepClone(store.getState().todos); };
  app.commitTodos = function (fn) {
    const before = app.snapshotTodos();
    fn();
    store.dispatch({ type: 'history/push', snapshot: before });
  };
  app.undoTodos = function () {
    store.dispatch({ type: 'history/undo' });
    const st = store.getState();
    if (st.history.future.length === 0) return;
    const cur = deepClone(st.todos);
    store.dispatch({ type: 'todos/replace', snapshot: st.history.future[st.history.future.length - 1] });
    store.dispatch({ type: 'history/redo' });
    store.dispatch({ type: 'history/push', snapshot: cur });
  };
  app.redoTodos = function () {
    const st = store.getState();
    if (st.history.future.length === 0) return;
    const cur = deepClone(st.todos);
    store.dispatch({ type: 'history/redo' });
    store.dispatch({ type: 'todos/replace', snapshot: store.getState().history.past[store.getState().history.past.length - 1] });
    store.dispatch({ type: 'history/push', snapshot: cur });
  };
  app.runUndo = function () { store.dispatch({ type: 'history/undo' }); };
  app.runRedo = function () { store.dispatch({ type: 'history/redo' }); };

  // global computed: cross-store totals + typed-array sums
  app.totals = new Computed(function totalsComputed() {
    const st = store.getState();
    const t = todoStats(st.todos.items);
    const k = kanbanCounts(st.kanban);
    let priceSum = 0, qtySum = 0;
    for (let i = 0; i < app.prices.length; i++) {
      priceSum += app.prices[i];
      qtySum += app.quantities[i];
    }
    return {
      todosTotal: t.total, todosRemaining: t.remaining, kanbanCards: k,
      priceSum: priceSum, qtySum: qtySum, theme: st.ui.theme, lang: st.ui.lang,
      opCount: st.meta.opCount, notifications: st.notifications.queue.length
    };
  });

  // memoized selectors over the store
  const visibleTodosSelector = createSelector(
    function () { return store.getState().todos; },
    function (todosSlice) { return visibleTodos(todosSlice.items, todosSlice.filter); }
  );
  const tablePipeSelector = createSelector(
    function () { return store.getState().table; },
    function (tableSlice) { return applyTablePipeline(tableSlice.rows, tableSlice.query, tableSlice.sort); }
  );
  const settingsErrorsSelector = createSelector(
    function () { return store.getState().settings; },
    function (settingsSlice) { return validateSettings(settingsSlice); }
  );
  app.selectors = { visibleTodosSelector: visibleTodosSelector, tablePipeSelector: tablePipeSelector, settingsErrorsSelector: settingsErrorsSelector };

  /* ----------------------- UI components (views) ------------------------- */

  /** Status bar: class component with lifecycle + deterministic flash. */
  class StatusBar extends Component {
    constructor(props, ctx) {
      super(props, ctx);
      this.state = { route: props.route, flash: 0 };
    }
    onMount() {
      const self = this;
      app.scheduler.schedule(function () { self.setState({ flash: self.state.flash + 1 }); }, 2);
    }
    onUpdate(prev, next) {
      if (prev.route !== next.route) this.setState({ route: next.route, flash: this.state.flash + 1 });
    }
    onUnmount() { this.state.flash = -1; }
    render() {
      const st = store.getState();
      return h('div', { class: 'status flash-' + (this.state.flash % 3) }, [
        h('span', { class: 'status-route' }, ['/' + st.ui.lang + st.ui.theme + '/' + this.state.route + (this.state.flash > 0 ? ' flashed#' + this.state.flash : '')]),
        h('span', { class: 'status-count' }, [String(st.meta.opCount)])
      ]);
    }
  }

  /** Todo row: class component with per-row editing state. */
  class TodoRow extends Component {
    constructor(props, ctx) {
      super(props, ctx);
      this.state = { editing: false, draft: '' };
    }
    onUpdate(prev, next) {
      if (prev.todo !== next.todo && !this.state.editing) this.setState({ draft: next.todo.text });
    }
    render() {
      const todo = this.props.todo;
      const label = this.state.editing ? this.state.draft : todo.text;
      return h('li', { class: 'todo-item ' + todo.status + ' p' + todo.priority }, [
        h('input', { type: 'checkbox', checked: todo.status === 'done' ? 'checked' : '', 'data-id': todo.id }),
        h('span', { class: 'todo-text' }, [label]),
        h('button', { class: 'todo-edit' }, [this.state.editing ? 'save' : 'edit'])
      ]);
    }
  }

  /** Sortable header: class component with hover state. */
  class SortHeader extends Component {
    constructor(props, ctx) {
      super(props, ctx);
      this.state = { hover: false };
    }
    render() {
      const col = this.props.col;
      const sort = this.props.sort;
      const active = sort && sort.col === col;
      return h('th', { class: 'sort-header ' + (this.props.active ? 'active' : ''), 'data-col': col }, [
        col,
        h('span', { class: 'sort-dir ' + (active ? (sort.dir > 0 ? 'asc' : 'desc') : 'none') }, [active ? (sort.dir > 0 ? '▲' : '▼') : '·'])
      ]);
    }
  }

  function Nav(props) {
    const st = store.getState();
    const keys = ['todos', 'kanban', 'table', 'docs', 'analytics', 'settings'];
    const items = [];
    for (let i = 0; i < keys.length; i++) {
      const active = props.route.indexOf(keys[i]) === 0;
      items.push(h('a', { class: 'nav-item ' + (active ? 'active' : ''), href: '/' + keys[i], 'data-route': keys[i] },
        [translate(st.ui.lang, 'nav.' + keys[i])]));
    }
    return h('nav', { class: 'app-nav' }, items);
  }

  function filterButton(name, t, filter) {
    return h('a', { class: 'filter-btn ' + (filter === name ? 'on' : ''), 'data-filter': name }, [t[name] || name]);
  }

  function TodosView(props) {
    const app2 = props.app;
    const st = store.getState();
    const filter = st.todos.filter;
    const visible = app2.selectors.visibleTodosSelector();
    const stats = todoStats(st.todos.items);
    const t = translate(st.ui.lang, 'todos');
    const rows = [];
    for (let i = 0; i < visible.length; i++) {
      rows.push(component(TodoRow, { todo: visible[i], actions: app2.actions }, visible[i].id));
    }
    const remaining = filter === 'done' ? stats.done : stats.remaining;
    return h('section', { class: 'view todos-view' }, [
      h('header', { class: 'view-head' }, [
        h('h2', { class: 'view-title' }, [t.title]),
        h('span', { class: 'view-sub' }, [translate(st.ui.lang, 'todos.remaining', { count: remaining })])
      ]),
      h('div', { class: 'todo-input-row' }, [
        h('input', { class: 'todo-input', placeholder: t.addPlaceholder, value: props.draft }),
        h('button', { class: 'todo-add' }, [t.add])
      ]),
      h('div', { class: 'todo-filters' }, [
        filterButton('all', t, filter), ' ', filterButton('active', t, filter), ' ', filterButton('done', t, filter)
      ]),
      h('ul', { class: 'todo-list' }, rows),
      h('footer', { class: 'todo-footer' }, [
        h('button', { class: 'todo-toggle-all' }, [t.toggleAll]),
        h('button', { class: 'todo-clear-done' }, [t.clearDone])
      ])
    ]);
  }

  function KanbanView(props) {
    const st = store.getState();
    const colNodes = [];
    const cols = st.kanban.columns;
    for (let i = 0; i < cols.length; i++) {
      const cards = [];
      for (let j = 0; j < cols[i].items.length; j++) {
        const card = cols[i].items[j];
        cards.push(h('div', { class: 'kanban-card tag-' + card.tag, 'data-id': card.id }, [
          h('span', { class: 'kanban-card-text' }, [card.text]),
          h('span', { class: 'kanban-card-tag' }, [card.tag])
        ]));
      }
      colNodes.push(h('div', { class: 'kanban-col', 'data-col': cols[i].id }, [
        h('h3', { class: 'kanban-col-title' }, [cols[i].title, h('span', { class: 'kanban-count' }, [String(cards.length)])]),
        h('div', { class: 'kanban-cards' }, cards),
        h('button', { class: 'kanban-add' }, [translate(st.ui.lang, 'kanban.add')])
      ]));
    }
    return h('section', { class: 'view kanban-view' }, [
      h('header', { class: 'view-head' }, [h('h2', { class: 'view-title' }, [translate(st.ui.lang, 'kanban.title')])]),
      h('div', { class: 'kanban-board' }, colNodes)
    ]);
  }

  function DataTable(props) {
    const app2 = props.app;
    const st = store.getState();
    const tbl = st.table;
    const sorted = app2.selectors.tablePipeSelector().sorted;
    const total = sorted.length;
    const pageCount = Math.max(1, Math.ceil(total / tbl.pageSize));
    const page = clamp(tbl.page, 0, pageCount - 1);
    const pageRows = sorted.slice(page * tbl.pageSize, (page + 1) * tbl.pageSize);
    const headCells = [];
    ['name', 'category', 'price', 'qty', 'score'].forEach(function (col) {
      headCells.push(component(SortHeader, { col: col, sort: tbl.sort, active: tbl.sort.col === col }, col));
    });
    const bodyRows = [];
    for (let i = 0; i < pageRows.length; i++) {
      const r = pageRows[i];
      bodyRows.push(h('tr', { class: 'table-row', 'data-id': r.id }, [
        h('td', { class: 'cell name' }, [r.name]),
        h('td', { class: 'cell category' }, [r.category]),
        h('td', { class: 'cell price' }, [dec(r.price, 2)]),
        h('td', { class: 'cell qty' }, [String(r.qty)]),
        h('td', { class: 'cell score' }, [dec(r.score, 2)])
      ]));
    }
    const idxs = [];
    for (let i = 0; i < pageRows.length; i++) idxs.push(tbl.rows.indexOf(pageRows[i]));
    const sums = sumVisible(app2.prices, app2.quantities, app2.scores, idxs);
    return h('section', { class: 'view table-view' }, [
      h('header', { class: 'view-head' }, [
        h('h2', { class: 'view-title' }, [translate(st.ui.lang, 'table.title')]),
        h('span', { class: 'view-sub' }, [translate(st.ui.lang, 'table.rows', { count: total })])
      ]),
      h('div', { class: 'table-toolbar' }, [
        h('input', { class: 'table-search', value: tbl.query, placeholder: translate(st.ui.lang, 'table.search') }),
        h('span', { class: 'table-sums' }, ['Σprice=' + dec(sums.p, 2), ' Σqty=' + sums.q, ' Σscore=' + dec(sums.s, 2)])
      ]),
      h('table', { class: 'data-table' }, [
        h('thead', null, [h('tr', { class: 'table-head' }, headCells)]),
        h('tbody', null, bodyRows)
      ]),
      h('div', { class: 'table-pager' }, [
        h('button', { class: 'page-prev btn' }, [translate(st.ui.lang, 'table.prev')]),
        h('span', { class: 'page-info' }, ['page ' + (page + 1) + '/' + pageCount]),
        h('button', { class: 'page-next btn' }, [translate(st.ui.lang, 'table.next')])
      ])
    ]);
  }

  function DocsView(props) {
    const st = store.getState();
    return h('section', { class: 'view docs-view' }, [
      h('header', { class: 'view-head' }, [
        h('h2', { class: 'view-title' }, [translate(st.ui.lang, 'docs.title')]),
        h('span', { class: 'view-sub' }, [translate(st.ui.lang, 'docs.words', { count: countWords(st.docs.src) })])
      ]),
      h('div', { class: 'docs-editor' }, [h('div', { class: 'docs-pane markdown' }, parseMarkdown(st.docs.src))])
    ]);
  }

  function AnalyticsView(props) {
    const st = store.getState();
    const an = st.analytics;
    const results = an.results;
    const bars = [];
    if (results) {
      const hist = results.values.hist;
      let maxBin = 0;
      for (let i = 0; i < hist.length; i++) if (hist[i] > maxBin) maxBin = hist[i];
      for (let i = 0; i < hist.length; i++) {
        const width = maxBin > 0 ? Math.round((hist[i] / maxBin) * 100) : 0;
        bars.push(h('div', { class: 'analytics-bar', 'data-bin': i, style: 'width:' + width + '%' }, [String(hist[i])]));
      }
    }
    const metricRows = [];
    if (results) {
      const v = results.values;
      metricRows.push(h('tr', null, [h('td', null, ['sum']), h('td', null, [dec(v.sum, 2)])]));
      metricRows.push(h('tr', null, [h('td', null, ['mean']), h('td', null, [dec(v.mean, 4)])]));
      metricRows.push(h('tr', null, [h('td', null, ['p50']), h('td', null, [dec(v.p50, 4)])]));
      metricRows.push(h('tr', null, [h('td', null, ['p90']), h('td', null, [dec(v.p90, 4)])]));
      metricRows.push(h('tr', null, [h('td', null, ['σ']), h('td', null, [dec(v.std, 4)])]));
    }
    return h('section', { class: 'view analytics-view' }, [
      h('header', { class: 'view-head' }, [
        h('h2', { class: 'view-title' }, [translate(st.ui.lang, 'analytics.title')]),
        h('span', { class: 'view-sub' }, [an.dataset + ' / ' + an.timeframe + ' / #' + an.aggTick])
      ]),
      h('div', { class: 'analytics-bars' }, bars.length > 0 ? bars : [h('div', { class: 'analytics-empty' }, ['no data yet'])]),
      h('table', { class: 'metric-table' }, [h('tbody', null, metricRows)])
    ]);
  }

  function SettingsView(props) {
    const app2 = props.app;
    const st = store.getState();
    const set = st.settings;
    const errors = app2.selectors.settingsErrorsSelector();
    const errorCount = Object.keys(errors).length;
    const field = function (name, label, value, type) {
      const err = errors[name];
      const touched = set.touched[name];
      const nodes = [
        h('label', { class: 'field-label', for: 'f-' + name }, [label]),
        h('input', { class: 'field-input ' + (err && touched ? 'invalid' : ''), id: 'f-' + name, type: type || 'text', value: value, 'data-field': name })
      ];
      if (err && touched) nodes.push(h('span', { class: 'field-error' }, [err]));
      return h('div', { class: 'form-field' }, nodes);
    };
    return h('section', { class: 'view settings-view' }, [
      h('header', { class: 'view-head' }, [
        h('h2', { class: 'view-title' }, [translate(st.ui.lang, 'settings.title')]),
        h('span', { class: 'view-sub' }, [errorCount === 0 ? translate(st.ui.lang, 'settings.valid') : translate(st.ui.lang, 'settings.invalid', { n: errorCount })])
      ]),
      h('form', { class: 'settings-form', novalidate: 'true' }, [
        field('username', translate(st.ui.lang, 'settings.username'), set.username),
        field('email', translate(st.ui.lang, 'settings.email'), set.email, 'email'),
        field('bio', translate(st.ui.lang, 'settings.bio'), set.bio),
        h('div', { class: 'form-field' }, [
          h('label', { class: 'field-label', for: 'f-difficulty' }, [translate(st.ui.lang, 'settings.difficulty')]),
          h('input', { class: 'field-input', id: 'f-difficulty', type: 'number', value: String(set.difficulty), 'data-field': 'difficulty' })
        ]),
        h('div', { class: 'form-field checkbox' }, [field('newsletter', translate(st.ui.lang, 'settings.newsletter'), set.newsletter ? 'on' : '', 'checkbox')]),
        h('div', { class: 'form-actions' }, [
          h('button', { class: 'btn form-save' }, [translate(st.ui.lang, 'settings.save')]),
          h('button', { class: 'btn form-reset' }, [translate(st.ui.lang, 'settings.reset')])
        ])
      ])
    ]);
  }

  function NotificationsView(props) {
    const st = store.getState();
    const queue = st.notifications.queue;
    const items = [];
    for (let i = 0; i < queue.length; i++) {
      const n = queue[i];
      items.push(h('div', { class: 'notification kind-' + n.kind, 'data-id': n.id }, [
        h('span', { class: 'notify-msg' }, [n.msg]),
        h('span', { class: 'notify-age' }, ['age ' + n.age + '/' + n.ttl])
      ]));
    }
    return h('section', { class: 'view notify-view' }, [
      h('header', { class: 'view-head' }, [
        h('h2', { class: 'view-title' }, [translate(st.ui.lang, 'notify.title')]),
        h('button', { class: 'btn notify-clear' }, [translate(st.ui.lang, 'notify.clear')])
      ]),
      h('div', { class: 'notify-list' }, items.length > 0 ? items : [h('div', { class: 'notify-empty' }, ['–'])])
    ]);
  }

  /** Modal command palette with fuzzy command list. */
  function PaletteModal(props) {
    const app3 = props.app;
    const st = store.getState();
    const ui = st.ui;
    if (!ui.paletteOpen) return null;
    const matches = searchCommands(app3.paletteCommands, ui.paletteQuery);
    const shown = matches.slice(0, 7);
    const items = [];
    for (let i = 0; i < shown.length; i++) {
      items.push(h('li', { class: 'palette-item ' + (i === ui.paletteIndex ? 'sel' : ''), 'data-cmd': shown[i].cmd.id }, [
        h('span', { class: 'palette-title' }, [shown[i].cmd.title]),
        h('span', { class: 'palette-score' }, [String(shown[i].score)])
      ]));
    }
    return h('div', { class: 'palette-overlay' }, [
      h('div', { class: 'palette-box' }, [
        h('input', { class: 'palette-input', value: ui.paletteQuery, placeholder: translate(st.ui.lang, 'palette.hint') }),
        h('ul', { class: 'palette-list' }, items)
      ])
    ]);
  }

  /** App shell: nav + status bar + active view + palette modal. */
  function AppShell(props) {
    const app3 = props.app;
    const st = store.getState();
    const route = app3.router.current.value;
    const viewMap = {
      todos: TodosView, kanban: KanbanView, table: DataTable, docs: DocsView,
      analytics: AnalyticsView, settings: SettingsView, 'todos-active': TodosView, 'table-page': DataTable
    };
    const contentFn = viewMap[route.name] || TodosView;
    return h('div', { class: 'app theme-' + st.ui.theme + (st.ui.sidebarCollapsed ? ' collapsed' : '') }, [
      h('header', { class: 'app-head' }, [
        h('h1', { class: 'app-logo' }, [translate(st.ui.lang, 'appTitle')]),
        component(StatusBar, { route: route.name }, 'statusbar')
      ]),
      Nav({ route: route.name }),
      h('main', { class: 'app-main' }, [component(contentFn, { app: app3 }, 'view-' + route.name)]),
      PaletteModal({ app: app3 })
    ]);
  }

  /* ----------------------- view controllers ------------------------------ */

  function createView(name) {
    return { name: name, tree: null, html: '', ctx: { instances: new Map(), touched: new Set() } };
  }
  const routeNames = router.routes.map(function (r) { return r.name; });
  for (let i = 0; i < routeNames.length; i++) app.views[routeNames[i]] = createView(routeNames[i]);

  // the single global render effect: reads route, ui tick, cross-store totals,
  // then renders the active view, diffs its tree and serializes the output.
  app.viewEffect = new Effect(function viewPass() {
    app.plugins.run('beforeRender', {});
    const route = router.current.value;
    app.uiTick.value;
    app.totals.value;
    const vc = app.views[route.name];
    if (app.activeView && app.activeView !== vc) teardownView(app.activeView);
    app.activeView = vc;
    vc.ctx.touched = new Set();
    const tree = toVNode(component(AppShell, { app: app }, 'shell'), vc.ctx, '/' + vc.name + '/[' + route.path + ']');
    vc.tree = vc.tree === null ? tree : patchNode(vc.tree, tree);
    reconcileInstances(vc.ctx);
    vc.html = serializeNode(vc.tree);
    app.lastHtml = vc.html;
    app.plugins.run('afterRender', {});
  });

  app.recomputeAnalytics = function () {
    const res = aggregateDatasets(app.datasets, store.getState().analytics.dataset, 12);
    store.dispatch({ type: 'analytics/refresh', results: res });
    app.bus.emit('aggregate:run', { dataset: res.dataset });
  };

  /* ------------------------ interaction ops ------------------------------ */

  const OPS = [];

  OPS.push({ name: 'todo:add', run: function (i) {
    const texts = ['Review diffs from baseline', 'Compact the signal graph', 'Re-run histogram pass', 'Tune overscan region', 'Fold nested routes', 'Sync dictionaries', 'Prune undo history'];
    app.commitTodos(function () {
      store.dispatch({ type: 'todos/add', id: todoNewId(), text: texts[i % texts.length] + ' #' + Math.floor(i / texts.length), priority: (i % 3) + 1, created: i });
    });
  } });
  OPS.push({ name: 'todo:toggle', run: function (i) {
    const items = store.getState().todos.items;
    if (items.length === 0) return;
    const item = items[Math.floor(app.rng() * items.length)];
    app.commitTodos(function () { store.dispatch({ type: 'todos/toggle', id: item.id }); });
  } });
  OPS.push({ name: 'todo:edit', run: function (i) {
    const items = store.getState().todos.items;
    if (items.length === 0) return;
    const item = items[Math.floor(app.rng() * items.length)];
    const suffix = [' [edited]', ' [x2]', ' [rev]', ' [draft]', ''][i % 5];
    store.dispatch({ type: 'todos/edit', id: item.id, text: item.text.replace(/\s*\[[^\]]*\]$/, '') + suffix });
  } });
  OPS.push({ name: 'todo:remove', run: function (i) {
    const items = store.getState().todos.items;
    if (items.length === 0) return;
    const id = items[Math.floor(app.rng() * items.length)].id;
    app.commitTodos(function () { store.dispatch({ type: 'todos/remove', id: id }); });
  } });
  OPS.push({ name: 'todo:filter', run: function (i) {
    store.dispatch({ type: 'todos/filter', filter: ['all', 'active', 'done'][i % 3] });
  } });
  OPS.push({ name: 'todo:toggleAll', run: function () { store.dispatch({ type: 'todos/toggleAll' }); } });
  OPS.push({ name: 'todo:clearDone', run: function () { store.dispatch({ type: 'todos/clearDone' }); } });

  const KANBAN_TEXTS = ['Wire the reducer', 'Migrate schema', 'Benchmark diff', 'Ship v0.9', 'Fuzz the router', 'Tune bins', 'Add i18n key', 'Fix table sort'];
  OPS.push({ name: 'kanban:add', run: function (i) {
    const colId = store.getState().kanban.columns[i % 3].id;
    store.dispatch({ type: 'kanban/add', columnId: colId, cardId: kanbanCardId(), text: KANBAN_TEXTS[i % 8] + ' #' + Math.floor(i / 8), tag: ['core', 'ui', 'perf'][i % 3] });
  } });
  OPS.push({ name: 'kanban:move', run: function (i) {
    const cols = store.getState().kanban.columns;
    const src = cols[i % 3];
    if (src.items.length === 0) return;
    const card = src.items[i % src.items.length];
    store.dispatch({ type: 'kanban/move', cardId: card.id, toColumnId: cols[(i + 1) % 3].id });
  } });
  OPS.push({ name: 'kanban:remove', run: function (i) {
    const src = store.getState().kanban.columns[i % 3];
    if (src.items.length === 0) return;
    store.dispatch({ type: 'kanban/remove', cardId: src.items[i % src.items.length].id });
  } });
  OPS.push({ name: 'kanban:rename', run: function (i) {
    store.dispatch({ type: 'kanban/rename', columnId: store.getState().kanban.columns[i % 3].id, title: ['Backlog', 'Doing', 'Done', 'Review', 'Next'][i % 5] });
  } });

  OPS.push({ name: 'table:sort', run: function (i) {
    const cols = ['name', 'category', 'price', 'qty', 'score'];
    store.dispatch({ type: 'table/sort', sort: { col: cols[i % 5], dir: (i % 7) === 0 ? -1 : 1 } });
  } });
  const SEARCH_WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'zulu'];
  OPS.push({ name: 'table:type', run: function (i) { // typing into the search box
    const word = SEARCH_WORDS[Math.floor(i / 7) % 25];
    store.dispatch({ type: 'table/query', query: word.slice(0, (i % 7) + 1) });
  } });
  OPS.push({ name: 'table:backspace', run: function (i) {
    const q = store.getState().table.query;
    store.dispatch({ type: 'table/query', query: q.length > 0 ? q.slice(0, -1) : q });
  } });
  OPS.push({ name: 'table:pageNext', run: function () {
    const tbl = store.getState().table;
    const total = Math.max(1, Math.ceil(filterRows(tbl.rows, tbl.query).length / tbl.pageSize));
    store.dispatch({ type: 'table/page', page: tbl.page + 1 >= total ? 0 : tbl.page + 1 });
  } });
  OPS.push({ name: 'table:pagePrev', run: function () {
    const tbl = store.getState().table;
    const total = Math.max(1, Math.ceil(filterRows(tbl.rows, tbl.query).length / tbl.pageSize));
    store.dispatch({ type: 'table/page', page: tbl.page === 0 ? total - 1 : tbl.page - 1 });
  } });
  OPS.push({ name: 'table:scroll', run: function (i) {
    const spill = store.getState().table.scrollTop + ((i % 3 === 0) ? -1 : 1) * 120;
    store.dispatch({ type: 'table/scroll', scrollTop: clamp(spill, 0, 6000) });
  } });
  OPS.push({ name: 'table:pageSize', run: function (i) {
    store.dispatch({ type: 'table/pageSize', size: [10, 20, 50][i % 3] });
  } });

  const DOC_FRAGMENTS = [' Additional notes: ', ' The **reactive core** covers signals, computed values and effects. ', ' `patchNode` reconciles keyed lists in O(n). ', ' *Determinism* is a hard requirement for the harness. ', ' Typed array histograms feed the analytics dashboard. ', ' Undo/redo snapshots are capped at eighty entries to bound memory. ', ' Command palette uses subsequence fuzzy scoring. '];
  OPS.push({ name: 'docs:type', run: function (i) { // type the next char into the doc
    const frag = DOC_FRAGMENTS[Math.floor(i / 24) % 7];
    const pos = i % 24;
    if (pos >= frag.length) return;
    const at = store.getState().docs.src.length;
    store.dispatch({ type: 'docs/insert', at: at, text: frag.charAt(pos) });
  } });
  OPS.push({ name: 'docs:delete', run: function (i) { store.dispatch({ type: 'docs/delete' }); } });

  OPS.push({ name: 'analytics:timeframe', run: function (i) {
    store.dispatch({ type: 'analytics/timeframe', timeframe: ['day', 'week', 'month'][i % 3] });
  } });
  OPS.push({ name: 'analytics:dataset', run: function (i) { store.dispatch({ type: 'analytics/dataset', dataset: i % 3 }); } });
  OPS.push({ name: 'analytics:recompute', run: function (i) { app.recomputeAnalytics(); } });

  const USERNAME_ALPHA = 'ada.lovelace';
  const EMAIL_ALPHA = 'ada@analytical.de';
  const BIO_ALPHA = 'Pioneer of computing and the analytical engine.';
  OPS.push({ name: 'settings:typeUsername', run: function (i) {
    store.dispatch({ type: 'settings/field', field: 'username', value: USERNAME_ALPHA.slice(0, i % 14) });
  } });
  OPS.push({ name: 'settings:typeEmail', run: function (i) {
    store.dispatch({ type: 'settings/field', field: 'email', value: EMAIL_ALPHA.slice(0, i % 17) });
  } });
  OPS.push({ name: 'settings:typeBio', run: function (i) {
    store.dispatch({ type: 'settings/field', field: 'bio', value: BIO_ALPHA.slice(0, i % 22) });
  } });
  OPS.push({ name: 'settings:validate', run: function () {
    const errors = validateSettings(store.getState().settings);
    const touched = {};
    Object.keys(errors).forEach(function (k) { touched[k] = true; });
    store.dispatch({ type: 'settings/touch', touched: touched });
  } });
  OPS.push({ name: 'settings:submitValid', run: function (i) {
    store.dispatch({ type: 'settings/field', field: 'username', value: USERNAME_ALPHA });
    store.dispatch({ type: 'settings/field', field: 'email', value: EMAIL_ALPHA });
    store.dispatch({ type: 'settings/field', field: 'bio', value: BIO_ALPHA });
    store.dispatch({ type: 'settings/field', field: 'difficulty', value: [1, 2, 3, 4, 5][i % 5] });
    const st = store.getState();
    const errors = validateSettings(st.settings);
    if (Object.keys(errors).length === 0) {
      store.dispatch({ type: 'settings/saved' });
      app.pushNotification('Settings saved (v' + st.settings.savedAt + ')', 'success', 2);
    }
  } });
  OPS.push({ name: 'settings:submitInvalid', run: function (i) {
    store.dispatch({ type: 'settings/field', field: 'email', value: 'not-an-email' });
    store.dispatch({ type: 'settings/field', field: 'difficulty', value: 9 });
    const errs = validateSettings(store.getState().settings);
    if (Object.keys(errs).length > 0) app.pushNotification('Form has ' + Object.keys(errs).length + ' error(s)', 'error', 2);
  } });
  OPS.push({ name: 'settings:reset', run: function () { store.dispatch({ type: 'settings/reset' }); } });

  const NOTIFY_MSGS = [['Build finished in 42s', 'success'], ['3 failing tests in suite B', 'error'], ['New comment on board', 'info'], ['Cache invalidated', 'info'], ['Deploy queued', 'success'], ['Disk usage at 87%', 'warn'], ['Schema migration ran', 'info'], ['PR merged: #512', 'success']];
  OPS.push({ name: 'notify:push', run: function (i) {
    const m = NOTIFY_MSGS[i % 8];
    app.pushNotification(m[0] + ' #' + Math.floor(i / 8), m[1], 2 + (i % 3));
  } });
  OPS.push({ name: 'notify:dismiss', run: function (i) {
    const q = store.getState().notifications.queue;
    if (q.length === 0) return;
    store.dispatch({ type: 'notify/dismiss', id: q[i % q.length].id });
  } });
  OPS.push({ name: 'notify:clear', run: function () { store.dispatch({ type: 'notify/clear' }); } });
  OPS.push({ name: 'notify:tick', run: function () { store.dispatch({ type: 'notify/tick' }); } });

  const PALETTE_QUERIES = ['th', 'the', 'theme', 'to', 'todo', 'nav', 'kan', 'setting', 'noti', 'undo', 'red', 'lan', 'doc', 'agg'];
  OPS.push({ name: 'palette:open', run: function () { store.dispatch({ type: 'palette/open' }); } });
  OPS.push({ name: 'palette:close', run: function () { store.dispatch({ type: 'palette/close' }); } });
  OPS.push({ name: 'palette:type', run: function (i) { store.dispatch({ type: 'palette/query', query: PALETTE_QUERIES[i % 14] }); } });
  OPS.push({ name: 'palette:move', run: function (i) { store.dispatch({ type: 'palette/move', delta: (i % 2 === 0) ? 1 : -1 }); } });
  OPS.push({ name: 'palette:exec', run: function (i) {
    const st = store.getState();
    if (!st.ui.paletteOpen) return;
    const matches = searchCommands(app.paletteCommands, st.ui.paletteQuery);
    if (matches.length === 0) return;
    matches[clamp(st.ui.paletteIndex, 0, matches.length - 1)].cmd.run();
    store.dispatch({ type: 'palette/close' });
  } });

  OPS.push({ name: 'undo', run: function () { app.undoTodos(); } });
  OPS.push({ name: 'redo', run: function () { app.redoTodos(); } });
  OPS.push({ name: 'ui:theme', run: function () {
    store.dispatch({ type: 'ui/theme', theme: store.getState().ui.theme === 'light' ? 'dark' : 'light' });
  } });
  OPS.push({ name: 'ui:lang', run: function (i) { store.dispatch({ type: 'ui/lang', lang: ['en', 'de', 'es'][i % 3] }); } });
  OPS.push({ name: 'ui:sidebar', run: function (i) { store.dispatch({ type: 'ui/sidebar', collapsed: (i % 2) === 0 }); } });

  const ROUTE_SEQ = ['todos', 'kanban', 'table', 'docs', 'analytics', 'settings', 'todos-active', 'table-page'];
  OPS.push({ name: 'route', run: function (i) {
    const target = ROUTE_SEQ[i % 8];
    if (target === 'todos-active') router.navigate('todos-active', { filter: ['all', 'active', 'done'][i % 3] });
    else if (target === 'table-page') router.navigate('table-page', { page: String((i % 5) + 1) });
    else router.navigate(target);
  } });
  OPS.push({ name: 'route:back', run: function () { router.back(); } });
  OPS.push({ name: 'route:forward', run: function () { router.forward(); } });

  OPS.push({ name: 'persist:roundtrip', run: function (i) {
    const restored = persistRoundTrip(app);
    // also exercise a legacy v1 payload migration deterministically
    const st = store.getState();
    const legacy = {
      schema: 1,
      state: {
        todos: st.todos.items.slice(0, 3).map(function (t) {
          return { id: t.id, text: t.text, done: t.status === 'done', created: t.created };
        }),
        settings: st.settings, docs: st.docs, kanban: st.kanban
      }
    };
    const migrated = migratePayload(legacy);
    const nextState = deepClone(st);
    nextState.todos.items = restored.todos.items;
    nextState.docs.src = migrated.docs.src;
    nextState.notifications = restored.notifications;
    store.dispatch({ type: 'state/restore', state: nextState });
    app.bus.emit('persist:done', { schema: SCHEMA_VERSION, round: i });
  } });

  OPS.push({ name: 'bus:emit', run: function (i) {
    app.bus.emit('user:activity', { seq: i, kind: 'input', at: i });
    app.bus.emit('todos:change', { n: store.getState().todos.items.length });
  } });
  OPS.push({ name: 'aggregate:quick', run: function (i) {
    const idx = Math.floor(app.rng() * app.datasets.length);
    const values = app.datasets[idx].values;
    let s = 0;
    for (let j = 0; j < values.length; j += 7) s += values[j];
    void s;
    app.bus.emit('aggregate:quick', { idx: idx, step: 7 });
  } });

  app.ops = OPS; // 50 ops total

  // deterministic boot burst so the app is alive at setup end
  app.warmup = [0, 5, 6, 22, 25, 27, 0, 9, 12, 30, 31, 32, 34, 36, 39];
  return app;
}

/* ----------------------------- 11. harness -------------------------------- */

globalThis.Benchmark = class Benchmark {
  constructor() {
    this.app = null;
    this._iterOps = 400;
    this._opIndex = 0;
    this._routeSwitchEvery = 12;
    this._persistEvery = 26;
    this._rng = createRng(0xBEEF);
  }

  setup() {
    const app = createApp();
    this.app = app;
    batch(function () { // warmup burst (deterministic, run once)
      for (let i = 0; i < app.warmup.length; i++) {
        app.ops[app.warmup[i]].run(i);
        if (i % 3 === 0) app.scheduler.tick();
        app.uiTick.set(app.uiTick.value + 1);
      }
    });
    batch(function () { app.viewEffect.run(); });           // initial render
    batch(function () { app.recomputeAnalytics(); app.viewEffect.run(); });
    batch(function () { app.router.navigate('todos'); app.viewEffect.run(); });
    batch(function () { void persistRoundTrip(app); app.viewEffect.run(); });
  }

  runIteration() {
    const app = this.app;
    const ops = app.ops;
    const n = ops.length;
    for (let k = 0; k < this._iterOps; k++) {
      const i = this._opIndex;
      this._opIndex += 1;
      let op;
      if (i % this._routeSwitchEvery === 0) op = ops[n - 6];           // route op
      else if (i % this._persistEvery === 0) op = ops[n - 3];          // persist:roundtrip
      else if (i % 5 === 0) op = ops[Math.floor(app.rng() * n)];
      else op = ops[i % n];
      const opIndex = Math.max(0, ops.indexOf(op));
      batch(function () {
        op.run(opIndex);
        // runtime frame loop: scheduler ticks + notify aging + activity bus
        if (k % 4 === 0) app.scheduler.tick();
        if (k % 7 === 0) app.store.dispatch({ type: 'notify/tick' });
        app.bus.emit('user:activity', { seq: i, kind: 'frame', at: k });
        const count = app.store.getState().meta.opCount + 1;
        app.store.dispatch({ type: 'meta/tick', count: count });
        app.uiTick.set(app.uiTick.value + 1);
      });
    }
    batch(function () { // settle: aggregate + full render
      app.recomputeAnalytics();
      app.viewEffect.run();
    });
  }

  /** Deterministic 32-bit checksum over final state + rendered output. */
  result() {
    const app = this.app;
    const st = app.store.getState();
    const route = app.router.current.value;
    const visible = app.selectors.visibleTodosSelector();
    const items = st.todos.items;
    let doneCount = 0;
    for (let i = 0; i < items.length; i++) if (items[i].status === 'done') doneCount += 1;
    const totals = app.totals.value;
    let priceSum = 0;
    for (let i = 0; i < app.prices.length; i++) priceSum += app.prices[i];
    const snapshot = {
      route: route.name, params: route.params, html: app.lastHtml,
      versions: { uiTick: app.uiTick.value, store: app.store.version.value, totals: app.totals.version, dispatches: app.store.dispatchCount },
      todos: { n: items.length, done: doneCount, filter: st.todos.filter,
        ids: visible.slice(0, 8).map(function (t) { return t.id; }).join(',') },
      kanban: kanbanCounts(st.kanban),
      table: { query: st.table.query, sort: st.table.sort.col + '/' + st.table.sort.dir, page: st.table.page,
        pageSize: st.table.pageSize, scrollTop: st.table.scrollTop, rows: st.table.rows.length },
      docs: { len: st.docs.src.length, words: countWords(st.docs.src) },
      analytics: { dataset: st.analytics.dataset, timeframe: st.analytics.timeframe, aggTick: st.analytics.aggTick,
        sum: st.analytics.results ? dec(st.analytics.results.values.sum, 4) : '',
        p90: st.analytics.results ? dec(st.analytics.results.values.p90, 4) : '',
        std: st.analytics.results ? dec(st.analytics.results.values.std, 4) : '' },
      settings: { username: st.settings.username, email: st.settings.email, bio: st.settings.bio,
        saved: st.settings.saved, savedAt: st.settings.savedAt },
      ui: { theme: st.ui.theme, lang: st.ui.lang, paletteOpen: st.ui.paletteOpen, paletteQuery: st.ui.paletteQuery },
      notifications: st.notifications.queue.map(function (n) { return n.id; }).join(','),
      history: { past: st.history.past.length, future: st.history.future.length },
      meta: { opCount: st.meta.opCount },
      totals: { priceSum: dec(priceSum, 2), qtySum: totals.qtySum, cards: totals.kanbanCards },
      bus: app.bus.counters,
      metrics: app.plugins.metrics
    };
    return fnv1a(JSON.stringify(snapshot));
  }
};