#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define SECRET_CAPACITY 4096

static size_t read_secret(const char *path, unsigned char *secret) {
  int descriptor = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (descriptor < 0) {
    return 0;
  }
  struct stat metadata;
  if (fstat(descriptor, &metadata) != 0 || !S_ISREG(metadata.st_mode) ||
      metadata.st_size < 1 || metadata.st_size >= SECRET_CAPACITY) {
    close(descriptor);
    return 0;
  }
  size_t used = 0;
  while (used < SECRET_CAPACITY - 1) {
    ssize_t count = read(descriptor, secret + used, SECRET_CAPACITY - 1 - used);
    if (count == 0) {
      break;
    }
    if (count < 0) {
      if (errno == EINTR) {
        continue;
      }
      close(descriptor);
      return 0;
    }
    used += (size_t)count;
  }
  close(descriptor);
  while (used > 0 && (secret[used - 1] == '\n' || secret[used - 1] == '\r')) {
    used--;
  }
  return used;
}

static int valid_port(const char *value) {
  char *end = NULL;
  errno = 0;
  long port = strtol(value, &end, 10);
  return errno == 0 && end != value && *end == '\0' && port >= 1 &&
         port <= 65535;
}

int main(int argc, char **argv) {
  if (argc != 3 || !valid_port(argv[2])) {
    return 2;
  }

  unsigned char secret[SECRET_CAPACITY] = {0};
  size_t secret_length = read_secret(argv[1], secret);
  if (secret_length == 0) {
    return 3;
  }

  char username[96];
  int username_length = snprintf(
      username, sizeof(username), "%lld:health",
      (long long)time(NULL) + 60);
  if (username_length < 1 || (size_t)username_length >= sizeof(username)) {
    OPENSSL_cleanse(secret, sizeof(secret));
    return 4;
  }

  unsigned char digest[EVP_MAX_MD_SIZE];
  unsigned int digest_length = 0;
  if (HMAC(EVP_sha1(), secret, (int)secret_length,
           (const unsigned char *)username, (size_t)username_length, digest,
           &digest_length) == NULL) {
    OPENSSL_cleanse(secret, sizeof(secret));
    return 5;
  }
  OPENSSL_cleanse(secret, sizeof(secret));

  char credential[4 * ((EVP_MAX_MD_SIZE + 2) / 3) + 1];
  int credential_length = EVP_EncodeBlock(
      (unsigned char *)credential, digest, (int)digest_length);
  OPENSSL_cleanse(digest, sizeof(digest));
  if (credential_length < 1 ||
      (size_t)credential_length >= sizeof(credential)) {
    return 6;
  }

  char *client_arguments[] = {
      "turnutils_uclient", "-u", username, "-w", credential,
      "-Y",                "alloc", "-I", "-c", "--no-even-port",
      "-m",                "1",     "-n", "1",  "-p",
      argv[2],             "127.0.0.1",
      NULL};
  execv("/usr/bin/turnutils_uclient", client_arguments);
  OPENSSL_cleanse(credential, sizeof(credential));
  return 7;
}
