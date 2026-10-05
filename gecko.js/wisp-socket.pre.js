// Test transport: return the destination observed by the actual JS bridge.
Module.tcpTransport = function (host, port, callbacks) {
  callbacks.onConnected();
  callbacks.onData(new TextEncoder().encode(host + ':' + port));
  return { send() {}, close() {} };
};
