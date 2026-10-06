// WISP TCP transport for the WasmFS socket backend (emsdk-patches/wisp_socket.h).
//
// Under WASMFS=1 the socket syscalls are C++ (libwasmfs), not JS -- so the old
// SOCKFS-based wisp shim (wisp-bridge.js + wisp-syscalls.js) can't attach. This
// --js-library instead provides the C-imported hooks the C++ SocketFile calls
// (wisp_open/connect/send/close) and, on incoming WISP DATA, calls back into
// the exported C delivery functions (_wisp_deliver / _wisp_set_connected /
// _wisp_set_eof / _wisp_set_error), each of which appends to the socket's rx
// buffer / flips state and wakes the C++ poll() futex.
//
// The WISP protocol itself (framing, v1/v2 negotiation, per-stream flow control
// via CONTINUE, extensions) is handled by @mercuryworkshop/wisp-js's
// ClientConnection, injected by the loader (js/index.ts) as
// Module.WispClientConnection. This library only bridges that client to the C++
// SocketFile contract: one ClientConnection to the WISP server, with each C++
// socket mapped to a wisp-js ClientStream keyed by the C++ socket id (which is
// monotonic and never reused, so it doubles as our stream map key). The client's
// WebSocket lives on the runtime main thread R; the hooks are __proxy:'sync' so
// they run there regardless of which Gecko pthread issued the syscall (matching
// the old SOCKFS-proxied-to-main model).

// Optional embedder transport — Module.tcpTransport:
//   connect(host, port, { onData, onConnected, onEof, onError }) → { send, close }
// When set, every stream routes through that factory and the WISP WebSocket is
// never opened. Absent → current WISP path, byte-for-byte. Generic embedder API
// (no host-app imports); pc uses it to bridge onto its own hostConnect() seam.

mergeInto(LibraryManager.library, {
  // --- DNS: keep the synthetic-IP <-> hostname map on the main thread R -------
  // gethostbyname() -> _emscripten_lookup_name allocates a fake 172.x IP and
  // records IP<->name in $DNS. Stock emscripten doesn't proxy it, so when Gecko
  // resolves on a DNS-resolver pthread the mapping lands in THAT worker's
  // (per-thread) $DNS, while wisp_connect (on R) reverse-looks-up an empty map
  // and WISP CONNECTs to the raw IP. Proxy it to R so the alloc and the reverse
  // lookup share one map. (Carried over from wisp-syscalls.js; still a JS
  // override since _emscripten_lookup_name is JS, not a WasmFS C++ syscall.)
  _emscripten_lookup_name__proxy: 'sync',
  _emscripten_lookup_name__deps: ['$UTF8ToString', '$DNS', '$inetPton4'],
  _emscripten_lookup_name: function (name) {
    return inetPton4(DNS.lookup_name(UTF8ToString(name)));
  },

  // --- WISP connection state + helpers (only ever touched on R) --------------
  $WISP__deps: ['$DNS'],
  $WISP: {
    conn: null,
    disposed: false,
    dispose: function () {
      WISP.disposed = true;
      var streams = WISP.customStreams;
      WISP.customStreams = null;
      if (streams) {
        var handles = Array.from(streams.values());
        streams.clear(); // Late/synchronous callbacks must not enter the dead heap.
        for (var handle of handles) { try { handle.close(); } catch (e) {} }
      }
      var conn = WISP.conn;
      WISP.conn = null;
      if (conn) {
        conn.ready = false;
        conn.pending = [];
        for (var stream of Object.values(conn.streams)) {
          stream.onmessage = stream.onclose = function () {};
          try { stream.close(); } catch (e) {}
        }
        conn.streams = {};
        conn.client.onopen = conn.client.onclose = conn.client.onerror = function () {};
        try { conn.client.close(); } catch (e) {}
      }
    },
    // Streams opened via Module.tcpTransport — keyed by C++ socket id, same as
    // WISP stream ids. Kept separate so a custom-transport connect never opens
    // the WISP WebSocket (and a WISP connect never looks here).
    customStreams: null,
    customFactory: function () {
      return (typeof Module !== 'undefined' && typeof Module.tcpTransport === 'function')
        ? Module.tcpTransport
        : null;
    },
    ensureCustomStreams: function () {
      if (!WISP.customStreams) WISP.customStreams = new Map();
      return WISP.customStreams;
    },
    // Lazily open the single ClientConnection to Module.wispUrl (set by index.ts,
    // which also injects the wisp-js ClientConnection class as
    // Module.WispClientConnection). `ready` flips on the WISP handshake (onopen);
    // `streams` maps C++ socket id -> wisp-js ClientStream; `pending` holds
    // connects issued before the handshake completed.
    ensureConn: function () {
      if (WISP.disposed) return null;
      if (WISP.conn) return WISP.conn;
      var url = (typeof Module !== 'undefined') && Module.wispUrl;
      if (!url) { err('[wisp] Module.wispUrl unset; networking disabled'); return null; }
      var Ctor = (typeof Module !== 'undefined') && Module.WispClientConnection;
      if (!Ctor) { err('[wisp] Module.WispClientConnection unset; networking disabled'); return null; }
      // wisp-js requires the endpoint to end with a trailing slash; be lenient.
      if (url[url.length - 1] !== '/') url += '/';
      var conn = { client: null, ready: false, pending: [], streams: {} };
      var client = new Ctor(url);
      conn.client = client;
      client.onopen = function () {
        conn.ready = true;
        var p = conn.pending; conn.pending = [];
        for (var i = 0; i < p.length; i++) { try { p[i](); } catch (e) {} }
      };
      // Connection-level teardown: EOF every live stream and fail queued connects.
      var teardown = function (errno) {
        conn.ready = false;
        var ids = Object.keys(conn.streams);
        for (var i = 0; i < ids.length; i++) {
          var id = ids[i] >>> 0;
          try { errno ? _wisp_set_error(id, errno) : _wisp_set_eof(id); } catch (e) {}
        }
        conn.streams = {};
        var p = conn.pending; conn.pending = [];
        for (var j = 0; j < p.length; j++) { try { p[j](errno || 111 /* ECONNREFUSED */); } catch (e) {} }
      };
      client.onclose = function () { teardown(0); };
      client.onerror = function () { teardown(111 /* ECONNREFUSED */); };
      WISP.conn = conn;
      return conn;
    },
    _deliverCustom: function (id, chunk) {
      if (!chunk) return;
      var u8 = (chunk instanceof Uint8Array)
        ? chunk
        : (chunk instanceof ArrayBuffer)
          ? new Uint8Array(chunk)
          : null;
      if (!u8 || !u8.length) return;
      var streams = WISP.customStreams;
      if (!streams || !streams.has(id)) return;
      var ptr = _malloc(u8.length);
      HEAPU8.set(u8, ptr);
      try { _wisp_deliver(id, ptr, u8.length); } finally { _free(ptr); }
    },
    doConnectCustom: function (id, host, port, factory) {
      var streams = WISP.ensureCustomStreams();
      // A transport may report connection/data synchronously from its factory.
      // Register ownership first; terminal callbacks remove it and must not be
      // undone when the factory returns its handle.
      var pending = { send: function () {}, close: function () {} };
      streams.set(id, pending);
      try {
        var handle = factory(host, port & 0xffff, {
          onData: function (chunk) { WISP._deliverCustom(id, chunk); },
          onConnected: function () {
            if (!streams.has(id)) return;
            try { _wisp_set_connected(id); } catch (e) {}
          },
          onEof: function () {
            if (!streams.has(id)) return;
            streams.delete(id);
            try { _wisp_set_eof(id); } catch (e) {}
          },
          onError: function (code) {
            if (!streams.has(id)) return;
            streams.delete(id);
            try { _wisp_set_error(id, (code >>> 0) || 111 /* ECONNREFUSED */); } catch (e) {}
          },
        });
        if (!handle || typeof handle.send !== 'function' || typeof handle.close !== 'function') {
          streams.delete(id);
          try { _wisp_set_error(id, 111 /* ECONNREFUSED */); } catch (e) {}
          return;
        }
        if (streams.get(id) === pending) streams.set(id, handle);
        else { try { handle.close(); } catch (e) {} }
      } catch (e) {
        streams.delete(id);
        err('[wisp] Module.tcpTransport connect failed: ' + e);
        try { _wisp_set_error(id, 111 /* ECONNREFUSED */); } catch (e2) {}
      }
    },
    doConnect: function (id, host, port) {
      if (WISP.disposed) return;
      // Synthetic DNS addresses (including IPv4-mapped IPv6, normalized by
      // C++) resolve back to hostnames; real IP literals pass through unchanged.
      try { if (DNS.lookup_addr) { var nm = DNS.lookup_addr(host); if (nm) host = nm; } } catch (e) {}

      var factory = WISP.customFactory();
      if (factory) { WISP.doConnectCustom(id, host, port, factory); return; }
      var conn = WISP.ensureConn();
      if (!conn) { try { _wisp_set_error(id, 111 /* ECONNREFUSED */); } catch (e) {} return; }
      // `failed` is set (with an errno) if the handshake collapsed while this
      // connect was still queued (teardown calls the pending thunk with an arg).
      var go = function (failed) {
        if (failed) { try { _wisp_set_error(id, failed); } catch (e) {} return; }
        var stream;
        try { stream = conn.client.create_stream(host, port & 0xffff); }
        catch (e) { err('[wisp] create_stream failed: ' + e); try { _wisp_set_error(id, 111); } catch (e2) {} return; }
        conn.streams[id] = stream;
        stream.onmessage = function (bytes) {
          if (WISP.disposed) return;
          var u8 = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
          var n = u8.length;
          if (n > 0) {
            // Copy the payload into the wasm heap; _wisp_deliver appends it to the
            // socket's rx buffer (under the File lock) and wakes the poll() futex.
            var ptr = _malloc(n);
            HEAPU8.set(u8, ptr);
            try { _wisp_deliver(id, ptr, n); } finally { _free(ptr); }
          }
        };
        // wisp-js calls onclose(reason) when the server sends CLOSE for this stream.
        stream.onclose = function () {
          if (conn.streams[id]) { delete conn.streams[id]; try { _wisp_set_eof(id); } catch (e) {} }
        };
        // WISP TCP doesn't ack connects; treat the stream as connected once CONNECT
        // is sent (matches the old shim's optimistic OPEN). Necko's poll then sees
        // POLLOUT and proceeds.
        try { _wisp_set_connected(id); } catch (e) {}
      };
      if (conn.ready) go(); else conn.pending.push(go);
    },
    doSend: function (id, ptr, len) {
      var streams = WISP.customStreams;
      if (streams && streams.has(id)) {
        var handle = streams.get(id);
        // sync-proxied: the calling worker is blocked, so the heap view is stable;
        // copy out before returning so the embedder can hold the bytes async.
        var copy = new Uint8Array(len);
        copy.set(HEAPU8.subarray(ptr, ptr + len));
        try { handle.send(copy); } catch (e) { err('[wisp] tcpTransport send failed: ' + e); }
        return;
      }
      var conn = WISP.conn;
      if (!conn) return;
      var stream = conn.streams[id];
      if (!stream) return;
      // Copy out of the heap: wisp-js may buffer the reference (per-stream flow
      // control) and send it after this sync-proxied call returns, by which point
      // the heap view is no longer valid.
      stream.send(HEAPU8.slice(ptr, ptr + len));
    },
    doClose: function (id) {
      var streams = WISP.customStreams;
      if (streams && streams.has(id)) {
        var handle = streams.get(id);
        streams.delete(id);
        try { handle.close(); } catch (e) {}
        return;
      }
      var conn = WISP.conn;
      if (!conn) return;
      var stream = conn.streams[id];
      if (!stream) return;
      delete conn.streams[id];
      try { stream.close(); } catch (e) {}
    },
  },

  // --- C++ -> JS hooks (proxied to R, where the WebSocket lives) -------------
  wisp_open__proxy: 'sync',
  wisp_open__deps: ['$WISP'],
  wisp_open: function (id) { if (!WISP.customFactory()) WISP.ensureConn(); },

  wisp_connect__proxy: 'sync',
  wisp_connect__deps: ['$WISP', '$UTF8ToString'],
  wisp_connect: function (id, host, port) { WISP.doConnect(id >>> 0, UTF8ToString(host), port >>> 0); },

  wisp_send__proxy: 'sync',
  wisp_send__deps: ['$WISP'],
  wisp_send: function (id, ptr, len) { WISP.doSend(id >>> 0, ptr, len); },

  wisp_close__proxy: 'sync',
  wisp_close__deps: ['$WISP'],
  wisp_close: function (id) { WISP.doClose(id >>> 0); },
});
