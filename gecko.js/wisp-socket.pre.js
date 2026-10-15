// Test transport: return the destination observed by the actual JS bridge.
Module.tcpTransport = function (host, port, callbacks, scopeId) {
  if (scopeId === 42 || scopeId === 43) {
    callbacks.onError(scopeId === 42 ? 19 /* ENODEV */ : 22 /* EINVAL */);
    return { send() {}, close() {} };
  }
  callbacks.onConnected();
  callbacks.onData(new TextEncoder().encode(host + ':' + port + (scopeId ? ':' + scopeId : '')));
  return { send() {}, close() {} };
};
Module.tcpTransport.supportsScopes = true;
