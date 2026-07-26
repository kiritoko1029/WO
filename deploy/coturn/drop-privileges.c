#define _GNU_SOURCE

#include <errno.h>
#include <grp.h>
#include <limits.h>
#include <linux/capability.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

static void fail(const char *operation) {
  fprintf(stderr, "%s failed: %s\n", operation, strerror(errno));
  exit(70);
}

static void invalid(const char *message) {
  fprintf(stderr, "%s\n", message);
  exit(64);
}

static unsigned long parse_id(const char *source, const char *label) {
  char *end = NULL;
  errno = 0;
  unsigned long value = strtoul(source, &end, 10);
  if (errno != 0 || end == source || *end != '\0' || value > UINT_MAX) {
    invalid(label);
  }
  return value;
}

static int last_capability(void) {
  FILE *source = fopen("/proc/sys/kernel/cap_last_cap", "r");
  if (source == NULL) {
    fail("open cap_last_cap");
  }
  int capability = -1;
  if (fscanf(source, "%d", &capability) != 1 || capability < 0 ||
      capability > 1024) {
    fclose(source);
    invalid("cap_last_cap is invalid");
  }
  if (fclose(source) != 0) {
    fail("close cap_last_cap");
  }
  return capability;
}

static void drop_bounding_set(int last) {
  for (int capability = 0; capability <= last; capability++) {
    if (prctl(PR_CAPBSET_DROP, capability, 0, 0, 0) != 0) {
      fail("drop capability bounding set");
    }
  }
}

static void verify_capabilities_cleared(int last) {
  struct __user_cap_header_struct header = {
      .version = _LINUX_CAPABILITY_VERSION_3,
      .pid = 0,
  };
  struct __user_cap_data_struct data[_LINUX_CAPABILITY_U32S_3] = {0};
  if (syscall(SYS_capget, &header, data) != 0) {
    fail("read process capabilities");
  }
  for (size_t index = 0; index < _LINUX_CAPABILITY_U32S_3; index++) {
    if (data[index].effective != 0 || data[index].permitted != 0 ||
        data[index].inheritable != 0) {
      invalid("process capabilities were not cleared");
    }
  }
  for (int capability = 0; capability <= last; capability++) {
    int present = prctl(PR_CAPBSET_READ, capability, 0, 0, 0);
    if (present < 0) {
      fail("read capability bounding set");
    }
    if (present != 0) {
      invalid("capability bounding set was not cleared");
    }
  }
}

int main(int argc, char **argv) {
  if (argc < 4) {
    invalid("usage: wo-drop-privileges UID GID PROGRAM [ARG...]");
  }
  if (geteuid() != 0) {
    invalid("wo-drop-privileges must start as root");
  }

  uid_t uid = (uid_t)parse_id(argv[1], "UID is invalid");
  gid_t gid = (gid_t)parse_id(argv[2], "GID is invalid");
  int last = last_capability();

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fail("set no_new_privs");
  }
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) != 0) {
    fail("clear ambient capabilities");
  }
  drop_bounding_set(last);
  if (setgroups(0, NULL) != 0) {
    fail("clear supplementary groups");
  }
  if (setresgid(gid, gid, gid) != 0) {
    fail("set process GID");
  }
  if (setresuid(uid, uid, uid) != 0) {
    fail("set process UID");
  }
  if (getuid() != uid || geteuid() != uid || getgid() != gid ||
      getegid() != gid) {
    invalid("process identity did not change");
  }
  if (prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1) {
    invalid("no_new_privs was not retained");
  }
  verify_capabilities_cleared(last);

  execvp(argv[3], &argv[3]);
  fail("execute target");
}
