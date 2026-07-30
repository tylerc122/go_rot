#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void fail(const char *message) {
  fprintf(stderr, "Go Rot: %s\n", message);
  exit(1);
}

static char *joined(const char *left, const char *right) {
  size_t size = strlen(left) + strlen(right) + 2;
  char *result = malloc(size);
  if (!result) fail("out of memory");
  snprintf(result, size, "%s/%s", left, right);
  return result;
}

int main(int argc, char **argv) {
  uint32_t executable_size = PATH_MAX;
  char executable[PATH_MAX];
  if (_NSGetExecutablePath(executable, &executable_size) != 0) {
    fail("could not locate the app bundle");
  }

  char resolved[PATH_MAX];
  if (!realpath(executable, resolved)) fail("could not resolve the app bundle");

  char executable_copy[PATH_MAX];
  strlcpy(executable_copy, resolved, sizeof(executable_copy));
  char *macos_directory = dirname(executable_copy);
  char contents_candidate[PATH_MAX];
  snprintf(contents_candidate, sizeof(contents_candidate), "%s/..", macos_directory);
  char contents[PATH_MAX];
  if (!realpath(contents_candidate, contents)) fail("invalid app layout");

  char bundle_candidate[PATH_MAX];
  snprintf(bundle_candidate, sizeof(bundle_candidate), "%s/..", contents);
  char bundle[PATH_MAX];
  if (!realpath(bundle_candidate, bundle)) fail("invalid app bundle");
  setenv("GO_ROT_APP_BUNDLE", bundle, 1);

  #if defined(__arm64__)
    const char *architecture = "arm64";
  #else
    const char *architecture = "x86_64";
  #endif

  char runtime_relative[PATH_MAX];
  snprintf(runtime_relative, sizeof(runtime_relative), "Frameworks/node/%s/bin/node", architecture);
  char *runtime = joined(contents, runtime_relative);
  setenv("GO_ROT_NODE", runtime, 1);

  const char *name = basename(argv[0]);
  const char *script_relative = NULL;
  int fixed_arguments = 0;
  if (strcmp(name, "go-rot-native-host") == 0) {
    if (argc == 2 && strcmp(argv[1], "--go-rot-launch-check") == 0) {
      char *probe[] = {runtime, "--version", NULL};
      execv(runtime, probe);
      fail("could not launch the bundled runtime");
    }
    script_relative = "Resources/app/companion/native-host.mjs";
  } else if (strcmp(name, "go-rot-doctor") == 0) {
    script_relative = "Resources/app/scripts/doctor.mjs";
  } else if (strcmp(name, "uninstall-go-rot") == 0) {
    script_relative = "Resources/app/scripts/install.mjs";
    fixed_arguments = 2;
  } else {
    fail("unknown launcher name");
  }

  char *script = joined(contents, script_relative);
  int forwarded = strcmp(name, "uninstall-go-rot") == 0 ? 0 : argc - 1;
  char **node_arguments = calloc((size_t)(3 + fixed_arguments + forwarded), sizeof(char *));
  if (!node_arguments) fail("out of memory");
  int index = 0;
  node_arguments[index++] = runtime;
  node_arguments[index++] = script;
  if (fixed_arguments) {
    node_arguments[index++] = "uninstall";
    node_arguments[index++] = "--all";
  } else {
    for (int input = 1; input < argc; input++) node_arguments[index++] = argv[input];
  }
  node_arguments[index] = NULL;
  execv(runtime, node_arguments);
  fail("could not launch the bundled Go Rot runtime");
}
