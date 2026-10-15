// Test transport: return the destination observed by the actual JS bridge.
// The second lookup simulates a VNet rebuild: the semantic name persists, but
// the previous numeric index must become stale.
var scopeLookups = 0;
Module.scopeIndex = function (name) {
  if (name !== 'lan') return 0;
  return ++scopeLookups === 1 ? 41 : 51;
};
Module.tcpTransport = function (host, port, callbacks, scopeId) {
  if (scopeId === 42 || scopeId === 43 || (scopeId === 41 && scopeLookups > 1)) {
    callbacks.onError(scopeId === 43 ? Module._wisp_errno_einval() : Module._wisp_errno_enodev());
    return { send() {}, close() {} };
  }
  callbacks.onConnected();
  callbacks.onData(new TextEncoder().encode(host + ':' + port + (scopeId ? ':' + scopeId : '')));
  return { send() {}, close() {} };
};
Module.tcpTransport.supportsScopes = true;
