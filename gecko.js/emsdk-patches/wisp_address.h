// TCP endpoint storage shared by the WasmFS socket syscalls. Keep the original
// family for socket queries; only the transport host normalizes mapped IPv4.
#pragma once

#include <algorithm>
#include <cstddef>
#include <cstring>
#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <sys/socket.h>

namespace wasmfs {
namespace wisp {

struct SocketAddress {
  sockaddr_storage value{};
  socklen_t size = 0;

  static SocketAddress wildcard(int domain) {
    SocketAddress result;
    result.value.ss_family = domain;
    result.size = domain == AF_INET6 ? sizeof(sockaddr_in6) : sizeof(sockaddr_in);
    return result;
  }

  int parse(int domain, const sockaddr* address, socklen_t length) {
    if (!address) return -EFAULT;
    if (length < offsetof(sockaddr, sa_family) + sizeof(address->sa_family)) return -EINVAL;
    const int family = address->sa_family;
    if (family != domain || (family != AF_INET && family != AF_INET6)) return -EAFNOSUPPORT;
    const socklen_t required = family == AF_INET6 ? sizeof(sockaddr_in6) : sizeof(sockaddr_in);
    if (length < required) return -EINVAL;
    // Neither transport exposes an interface index. Reject scoped destinations
    // instead of silently connecting to the wrong interface.
    if (family == AF_INET6 && ((const sockaddr_in6*)address)->sin6_scope_id) return -EOPNOTSUPP;
    value = {};
    std::memcpy(&value, address, required);
    size = required;
    return 0;
  }

  uint16_t port() const {
    return ntohs(value.ss_family == AF_INET6
      ? ((const sockaddr_in6*)&value)->sin6_port
      : ((const sockaddr_in*)&value)->sin_port);
  }

  const char* transportHost(char (&buffer)[INET6_ADDRSTRLEN]) const {
    if (value.ss_family == AF_INET6) {
      const auto& address = ((const sockaddr_in6*)&value)->sin6_addr;
      if (!IN6_IS_ADDR_V4MAPPED(&address)) return inet_ntop(AF_INET6, &address, buffer, sizeof(buffer));
      return inet_ntop(AF_INET, address.s6_addr + 12, buffer, sizeof(buffer));
    }
    return inet_ntop(AF_INET, &((const sockaddr_in*)&value)->sin_addr, buffer, sizeof(buffer));
  }

  int copyTo(sockaddr* address, socklen_t* length) const {
    if (!address || !length) return -EFAULT;
    if (!size) return -ENOTCONN;
    // POSIX truncates to caller capacity and returns the full required size.
    std::memcpy(address, &value, std::min(*length, size));
    *length = size;
    return 0;
  }
};

} // namespace wisp
} // namespace wasmfs
