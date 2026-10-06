#include "emsdk-patches/wisp_address.h"
#include <cassert>
#include <cstdio>

using wasmfs::wisp::SocketAddress;

int main() {
  for (int family : {AF_INET, AF_INET6}) {
    SocketAddress peer;
    auto address = SocketAddress::wildcard(family);
    if (family == AF_INET) {
      auto* sa = (sockaddr_in*)&address.value;
      sa->sin_port = htons(443);
      assert(inet_pton(family, "172.29.5.9", &sa->sin_addr) == 1);
    } else {
      auto* sa = (sockaddr_in6*)&address.value;
      sa->sin6_port = htons(443);
      assert(inet_pton(family, "fdcb:0:9:2:1234:5678:9abc:def0", &sa->sin6_addr) == 1);
    }
    auto* input = (sockaddr*)&address.value;
    assert(peer.parse(family, input, address.size) == 0);
    assert(peer.port() == 443);
    char host[INET6_ADDRSTRLEN];
    assert(std::strcmp(peer.transportHost(host), family == AF_INET ? "172.29.5.9" : "fdcb:0:9:2:1234:5678:9abc:def0") == 0);
    sockaddr_storage output{};
    socklen_t length = sizeof(output);
    assert(peer.copyTo((sockaddr*)&output, &length) == 0);
    assert(length == address.size);
    assert(std::memcmp(&output, input, length) == 0);
    // Exercise every truncation boundary, including a zero-capacity buffer.
    for (socklen_t capacity = 0; capacity < address.size; ++capacity) {
      unsigned char guarded[sizeof(sockaddr_storage)];
      std::memset(guarded, 0xa5, sizeof(guarded));
      length = capacity;
      assert(peer.copyTo((sockaddr*)guarded, &length) == 0);
      assert(length == address.size);
      assert(std::memcmp(guarded, input, capacity) == 0);
      for (size_t i = capacity; i < sizeof(guarded); ++i) assert(guarded[i] == 0xa5);
    }
    assert(peer.parse(family, input, address.size - 1) == -EINVAL);
    assert(peer.parse(family, input, 0) == -EINVAL);
    assert(peer.parse(family, nullptr, address.size) == -EFAULT);
    assert(peer.parse(family == AF_INET ? AF_INET6 : AF_INET, input, address.size) == -EAFNOSUPPORT);
    assert(peer.copyTo(nullptr, &length) == -EFAULT);
    assert(peer.copyTo((sockaddr*)&output, nullptr) == -EFAULT);
    auto local = SocketAddress::wildcard(family);
    assert(local.port() == 0);
    assert(std::strcmp(local.transportHost(host), family == AF_INET ? "0.0.0.0" : "::") == 0);
  }
  auto mapped = SocketAddress::wildcard(AF_INET6);
  auto* sa = (sockaddr_in6*)&mapped.value;
  sa->sin6_port = htons(8080);
  assert(inet_pton(AF_INET6, "::ffff:172.29.5.9", &sa->sin6_addr) == 1);
  SocketAddress peer;
  assert(peer.parse(AF_INET6, (sockaddr*)sa, mapped.size) == 0);
  char host[INET6_ADDRSTRLEN];
  assert(std::strcmp(peer.transportHost(host), "172.29.5.9") == 0);
  assert(peer.value.ss_family == AF_INET6);
  assert(peer.port() == 8080);
  sa->sin6_scope_id = 3;
  assert(peer.parse(AF_INET6, (sockaddr*)sa, mapped.size) == -EOPNOTSUPP);
  sockaddr_storage output{};
  socklen_t length = sizeof(output);
  assert(SocketAddress{}.copyTo((sockaddr*)&output, &length) == -ENOTCONN);
  puts("socket addresses: IPv4, IPv6, mapped IPv4, invalid inputs and bounded outputs passed");
}
