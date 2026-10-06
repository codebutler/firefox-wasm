import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function bridge(factory, names = { '172.29.5.9': 'probe.test' }) {
  const library = {};
  const events = [];
  const heap = new Uint8Array(4096);
  const clients = [];
  class Client {
    constructor(url) { this.url = url; this.streams = []; clients.push(this); }
    create_stream(host, port) {
      const stream = { host, port, sent: [], send(bytes) { this.sent.push(bytes); }, close() { this.closed = true; } };
      this.streams.push(stream);
      return stream;
    }
  }
  const context = {
    LibraryManager: { library }, mergeInto: Object.assign,
    Module: { tcpTransport: factory, wispUrl: 'wss://probe.invalid/wisp', WispClientConnection: Client },
    HEAPU8: heap, Uint8Array, ArrayBuffer, Map,
    DNS: { lookup_addr: address => names[address] },
    UTF8ToString: ptr => new TextDecoder().decode(heap.subarray(ptr, heap.indexOf(0, ptr))),
    _malloc: () => 1024, _free: () => {}, err: message => events.push(['log', message]),
    _wisp_set_connected: id => events.push(['connected', id]),
    _wisp_set_eof: id => events.push(['eof', id]),
    _wisp_set_error: (id, code) => events.push(['error', id, code]),
    _wisp_deliver: (id, ptr, len) => events.push(['data', id, Array.from(heap.slice(ptr, ptr + len))]),
  };
  vm.runInNewContext(readFileSync(new URL('./lib/wisp-net.js', import.meta.url), 'utf8'), context);
  context.WISP = library.$WISP;
  function connect(id, host, port) {
    heap.set(new TextEncoder().encode(host + '\0'), 64);
    library.wisp_connect(id, 64, port);
    heap.fill(0, 64, 128); // C++ stack string expires when the sync proxy returns.
  }
  return { library, events, heap, clients, connect, WISP: library.$WISP };
}

test('custom TCP transport never opens WISP and copies asynchronous payloads', () => {
  let callbacks;
  let sent;
  let closed = false;
  const b = bridge((host, port, cb) => {
    assert.equal(host, 'probe.test'); assert.equal(port, 443); callbacks = cb;
    return { send(bytes) { sent = bytes; }, close() { closed = true; } };
  });
  b.library.wisp_open(7);
  assert.equal(b.clients.length, 0);
  b.connect(7, '172.29.5.9', 443);
  callbacks.onConnected(); callbacks.onData(new Uint8Array([1, 2, 3]));
  b.heap.set([4, 5, 6], 16); b.library.wisp_send(7, 16, 3); b.heap.fill(0, 16, 19);
  assert.deepEqual(Array.from(sent), [4, 5, 6]);
  assert.deepEqual(b.events, [['connected', 7], ['data', 7, [1, 2, 3]]]);
  b.library.wisp_close(7); callbacks.onData(new Uint8Array([9])); callbacks.onEof();
  assert.equal(closed, true); assert.equal(b.events.length, 2);
});

test('custom synchronous connection/data callbacks are retained', () => {
  const b = bridge((host, port, cb) => {
    cb.onConnected(); cb.onData(new Uint8Array([8]));
    return { send() {}, close() {} };
  });
  b.connect(8, '172.29.5.9', 80);
  assert.deepEqual(b.events, [['connected', 8], ['data', 8, [8]]]);
});

test('a synchronous failure does not resurrect a custom stream', () => {
  let closed = false;
  const b = bridge((host, port, cb) => {
    cb.onError(111);
    return { send() {}, close() { closed = true; } };
  });
  b.connect(9, '172.29.5.9', 80);
  assert.deepEqual(b.events, [['error', 9, 111]]);
  assert.equal(b.WISP.customStreams.has(9), false);
  assert.equal(closed, true);
});

test('WISP fallback waits for handshake and forwards bytes and EOF', () => {
  const b = bridge();
  b.library.wisp_open(1); b.connect(1, '172.29.5.9', 80);
  assert.equal(b.clients.length, 1); assert.equal(b.events.length, 0);
  b.clients[0].onopen();
  const stream = b.clients[0].streams[0];
  assert.equal(stream.host, 'probe.test');
  assert.equal(b.clients[0].url, 'wss://probe.invalid/wisp/');
  stream.onmessage(new Uint8Array([2, 4]));
  b.heap.set([6, 8], 8); b.library.wisp_send(1, 8, 2); b.heap.fill(0, 8, 10);
  assert.deepEqual(Array.from(stream.sent[0]), [6, 8]);
  stream.onclose();
  assert.deepEqual(b.events, [['connected', 1], ['data', 1, [2, 4]], ['eof', 1]]);
});

for (const host of ['192.0.2.7', 'fdcb:0:9:2:1234:5678:9abc:def0', '::1']) {
  test('literal ' + host + ' reaches custom transport intact', () => {
    const b = bridge((actual, port, cb) => {
      assert.equal(actual, host); assert.equal(port, 8080);
      cb.onConnected(); return { send() {}, close() {} };
    });
    b.connect(4, host, 8080);
    assert.deepEqual(b.events, [['connected', 4]]);
    assert.equal(b.clients.length, 0);
  });
  test('literal ' + host + ' survives a queued WISP handshake', () => {
    const b = bridge();
    b.connect(5, host, 8080);
    b.clients[0].onopen();
    assert.equal(b.clients[0].streams[0].host, host);
    assert.equal(b.clients[0].streams[0].port, 8080);
    assert.deepEqual(b.events, [['connected', 5]]);
  });
}

test('runtime disposal closes connected and pending custom streams and ignores late callbacks', () => {
  const callbacks = []; let closed = 0;
  const b = bridge((_host, _port, cb) => { callbacks.push(cb); return {send() {}, close() {closed++; cb.onEof();}}; });
  b.connect(1, 'one.test', 80); b.connect(2, 'two.test', 80);
  callbacks[0].onConnected();
  b.WISP.dispose(); b.WISP.dispose();
  callbacks[0].onData(new Uint8Array([1])); callbacks[1].onConnected(); callbacks[1].onError();
  b.connect(3, 'late.test', 80);
  assert.equal(closed, 2); assert.equal(callbacks.length, 2);
  assert.deepEqual(b.events, [['connected', 1]]);
});
