// Tests the same NSPR socket API Gecko uses, through the real WasmFS bridge.
#include "prinit.h"
#include "prio.h"
#include "prnetdb.h"
#include "prerror.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>

static void check(const char* host, PRUint16 family, const char* expected,
                  PRBool nonblocking) {
  PRNetAddr address;
  PRAddrInfo* info = NULL;
  if (PR_StringToNetAddr(host, &address) == PR_SUCCESS) {
    assert(address.raw.family == family);
    address.inet.port = PR_htons(8080);
  } else {
    info = PR_GetAddrInfoByName(host, family, PR_AI_ADDRCONFIG);
    assert(info);
    assert(PR_EnumerateAddrInfo(NULL, info, 8080, &address));
  }
  PRFileDesc* fd = PR_OpenTCPSocket(address.raw.family);
  assert(fd);
  if (nonblocking) {
    PRSocketOptionData option = {.option = PR_SockOpt_Nonblocking};
    option.value.non_blocking = PR_TRUE;
    assert(PR_SetSocketOption(fd, &option) == PR_SUCCESS);
  }
  PRStatus result = PR_Connect(fd, &address, PR_SecondsToInterval(5));
  if (result != PR_SUCCESS && nonblocking) {
    assert(PR_GetError() == PR_IN_PROGRESS_ERROR || PR_GetError() == PR_WOULD_BLOCK_ERROR);
    PRPollDesc poll = {.fd = fd, .in_flags = PR_POLL_WRITE | PR_POLL_EXCEPT};
    assert(PR_Poll(&poll, 1, PR_SecondsToInterval(5)) == 1);
    result = PR_GetConnectStatus(&poll);
  }
  if (result != PR_SUCCESS) {
    fprintf(stderr, "NSPR connect %s failed: %d (OS %d)\n", host, PR_GetError(), PR_GetOSError());
  }
  assert(result == PR_SUCCESS);
  PRNetAddr peer;
  assert(PR_GetPeerName(fd, &peer) == PR_SUCCESS);
  assert(peer.raw.family == address.raw.family);
  char actual[128], wanted[128];
  assert(PR_NetAddrToString(&peer, actual, sizeof(actual)) == PR_SUCCESS);
  assert(PR_NetAddrToString(&address, wanted, sizeof(wanted)) == PR_SUCCESS);
  assert(strcmp(actual, wanted) == 0);
  assert(peer.inet.port == PR_htons(8080));
  PRPollDesc poll = {.fd = fd, .in_flags = PR_POLL_READ};
  assert(PR_Poll(&poll, 1, PR_SecondsToInterval(5)) == 1);
  char response[128] = {0};
  assert(PR_Recv(fd, response, sizeof(response) - 1, 0, PR_SecondsToInterval(5)) > 0);
  assert(strcmp(response, expected) == 0);
  assert(PR_Close(fd) == PR_SUCCESS);
  if (info) PR_FreeAddrInfo(info);
  printf("NSPR socket: %s (%s) -> %s\n", host, nonblocking ? "nonblocking" : "blocking", response);
}

// NSPR retains Linux sendfile in its method table. Like Gecko's unsupported
// syscall stub it must never run here; networking is not replaced by a stub.
ssize_t sendfile(int out_fd, int in_fd, off_t* offset, size_t count) { abort(); }

int main(void) {
  PR_Init(PR_USER_THREAD, PR_PRIORITY_NORMAL, 0);
  for (int nonblocking = 0; nonblocking <= 1; ++nonblocking) {
    check("fdcb:0:9:2:1234:5678:9abc:def0", PR_AF_INET6, "fdcb:0:9:2:1234:5678:9abc:def0:8080", nonblocking);
    check("::1", PR_AF_INET6, "::1:8080", nonblocking);
    check("::ffff:192.0.2.7", PR_AF_INET6, "192.0.2.7:8080", nonblocking);
    check("192.0.2.7", PR_AF_INET, "192.0.2.7:8080", nonblocking);
    check("probe.test", PR_AF_UNSPEC, "probe.test:8080", nonblocking);
    check("probe.test", PR_AF_INET, "probe.test:8080", nonblocking);
  }
  return 0;
}
