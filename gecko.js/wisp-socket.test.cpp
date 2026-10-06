// Runs through the actual patched WasmFS syscalls in a pthread. The JS fixture
// echoes the host observed at the transport boundary; it does not emulate libc.
#include <arpa/inet.h>
#include <cassert>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <netdb.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

static void check(const char* host, int family, const char* expected) {
  addrinfo hint{}, *address = nullptr;
  hint.ai_family = family;
  hint.ai_socktype = SOCK_STREAM;
  hint.ai_flags = AI_V4MAPPED;
  assert(getaddrinfo(host, "8080", &hint, &address) == 0);
  int fd = socket(family, SOCK_STREAM, 0);
  assert(fd >= 0);
  sockaddr_storage local{}, peer{};
  socklen_t length = sizeof(local);
  assert(getsockname(fd, (sockaddr*)&local, &length) == 0);
  assert(local.ss_family == family);
  assert(length == (family == AF_INET ? sizeof(sockaddr_in) : sizeof(sockaddr_in6)));
  assert(getpeername(fd, (sockaddr*)&peer, &length) == -1 && errno == ENOTCONN);
  assert(connect(fd, address->ai_addr, address->ai_addrlen - 1) == -1 && errno == EINVAL);
  assert(connect(fd, address->ai_addr, address->ai_addrlen) == -1 && errno == EINPROGRESS);
  pollfd poller{fd, POLLOUT | POLLIN, 0};
  assert(poll(&poller, 1, 1000) == 1);
  assert((poller.revents & (POLLOUT | POLLIN)) == (POLLOUT | POLLIN));
  length = sizeof(peer);
  assert(getpeername(fd, (sockaddr*)&peer, &length) == 0);
  assert(length == address->ai_addrlen);
  assert(std::memcmp(&peer, address->ai_addr, length) == 0);
  // recvfrom must preserve the family too, and may not overflow a short buffer.
  char bytes[128]{};
  unsigned char guard[32];
  std::memset(guard, 0xa5, sizeof(guard));
  length = 3;
  const ssize_t count = recvfrom(fd, bytes, sizeof(bytes) - 1, 0, (sockaddr*)guard, &length);
  assert(count > 0);
  assert(std::strcmp(bytes, expected) == 0);
  assert(length == address->ai_addrlen);
  assert(std::memcmp(guard, address->ai_addr, 3) == 0);
  for (size_t i = 3; i < sizeof(guard); ++i) assert(guard[i] == 0xa5);
  assert(close(fd) == 0);
  freeaddrinfo(address);
  printf("socket bridge: %s (family %d) -> %s\n", host, family, expected);
}

int main() {
  check("192.0.2.7", AF_INET, "192.0.2.7:8080");
  check("fdcb:0:9:2:1234:5678:9abc:def0", AF_INET6, "fdcb:0:9:2:1234:5678:9abc:def0:8080");
  check("::1", AF_INET6, "::1:8080");
  check("::ffff:192.0.2.7", AF_INET6, "192.0.2.7:8080");
  check("probe.test", AF_INET, "probe.test:8080");
  check("probe.test", AF_INET6, "probe.test:8080");
}
