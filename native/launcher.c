#define _GNU_SOURCE
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

// The launcher is statically linked. It keeps the installation self-contained
// by default without taking permissions away from the agent or its tools.
static char root[PATH_MAX];
static void die(const char *message) { perror(message); exit(1); }
static char *local(const char *suffix) {
    char *value;
    if (asprintf(&value, "%s/%s", root, suffix) < 0) die("path");
    return value;
}
static void directory(const char *suffix) {
    char *file = local(suffix);
    if (mkdir(file, 0700) && errno != EEXIST) die(file);
    struct stat st;
    if (lstat(file, &st) || !S_ISDIR(st.st_mode) || st.st_uid != getuid()) {
        fprintf(stderr, "directory must be owned by the current user and must not be a symlink: %s\n", file); exit(1);
    }
    free(file);
}
static void localenv(const char *key, const char *suffix) {
    char *value = local(suffix);
    if (setenv(key, value, 1)) die("environment");
    free(value);
}
static void prependenv(const char *key, const char *suffix) {
    char *value = local(suffix);
    const char *current = getenv(key);
    if (current && *current) {
        size_t length = strlen(value) + 1 + strlen(current) + 1;
        char *joined = malloc(length);
        if (!joined) die("environment");
        snprintf(joined, length, "%s:%s", value, current);
        if (setenv(key, joined, 1)) die("environment");
        free(joined);
    } else if (setenv(key, value, 1)) die("environment");
    free(value);
}
int main(int argc, char **argv) {
    ssize_t len = readlink("/proc/self/exe", root, sizeof(root) - 1);
    if (len < 0 || len >= (ssize_t)sizeof(root) - 1) die("launcher location");
    root[len] = 0;
    char *slash = strrchr(root, '/');
    if (!slash) return 1;
    *slash = 0;
    umask(0077);
    const struct rlimit no_core = {.rlim_cur = 0, .rlim_max = 0};
    if (setrlimit(RLIMIT_CORE, &no_core)) die("disable core dumps");
    const char *name = strrchr(argv[0], '/'); name = name ? name + 1 : argv[0];
    const char *command = !strcmp(name, "xltx") ? (argc > 1 ? argv[1] : "help") : name;
    int skip = !strcmp(name, "xltx") ? 2 : 1;
    // Keep the host configuration location only for service registration.
    const char *host_config = getenv("XDG_CONFIG_HOME");
    if (host_config && *host_config && !getenv("WEIXIN_HOST_CONFIG_HOME"))
        setenv("WEIXIN_HOST_CONFIG_HOME", host_config, 1);
    // Host programs and tools stay available; only runtime injection is removed.
    unsetenv("LD_PRELOAD"); unsetenv("NODE_OPTIONS"); unsetenv("NODE_PATH");
    setenv("WEIXIN_ROOT", root, 1);
    directory("data");
    const char *dirs[] = {"data/home", "data/config", "data/cache", "data/state", "data/share", "data/tmp", "data/pi", "data/logs", "data/run", "workspace"};
    for (size_t i = 0; i < sizeof(dirs)/sizeof(dirs[0]); i++) directory(dirs[i]);
    localenv("HOME", "data/home");
    localenv("XDG_CONFIG_HOME", "data/config"); localenv("XDG_CACHE_HOME", "data/cache");
    localenv("XDG_STATE_HOME", "data/state"); localenv("XDG_DATA_HOME", "data/share");
    localenv("TMPDIR", "data/tmp"); localenv("TMP", "data/tmp"); localenv("TEMP", "data/tmp");
    localenv("PI_CODING_AGENT_DIR", "data/pi"); localenv("PI_CODING_AGENT_SESSION_DIR", "data/sessions");
    localenv("PI_PACKAGE_DIR", "runtime/pi");
    prependenv("PATH", "runtime/bin");
    prependenv("LD_LIBRARY_PATH", "runtime/lib");
    localenv("SHELL", "runtime/bin/bash");
    localenv("npm_config_cache", "data/cache/npm"); localenv("npm_config_prefix", "data/home/npm");
    localenv("WEIXIN_CONFIG", "data/config.json");
    setenv("PI_SKIP_VERSION_CHECK", "1", 1); setenv("PI_TELEMETRY", "0", 1); setenv("PI_OFFLINE", "1", 1);
    localenv("XDG_RUNTIME_DIR", "data/run");
    // Tool/Pi wrappers must keep the workspace chosen by their caller.
    // Only the top-level management entry starts from the installation root.
    if (!strcmp(name, "xltx") && chdir(root)) die("installation directory");
    char **args = calloc((size_t)argc + 12, sizeof(char *));
    if (!args) die("arguments");
    int n = 0;
    args[n++] = local("runtime/lib/ld.so");
    args[n++] = "--library-path"; args[n++] = local("runtime/lib");
    int cli = !strcmp(command,"setup") || !strcmp(command,"start") || !strcmp(command,"stop") ||
        !strcmp(command,"restart") || !strcmp(command,"status") || !strcmp(command,"uninstall");
    if (!strcmp(command,"node") || !strcmp(command,"pi") || !strcmp(command,"run") || cli ||
        !strcmp(command,"check") || !strcmp(command,"login") || !strcmp(command,"logout") ||
        !strcmp(command,"logs") || !strcmp(command,"help") || !strcmp(command,"verify") ||
        !strcmp(command,"version") || !strcmp(command,"--version") || !strcmp(command,"-v")) {
        args[n++] = local("runtime/native/node");
        args[n++] = "--require"; args[n++] = local("src/portable-preload.cjs");
        if (!strcmp(command,"pi")) args[n++] = local("src/adapters/pi/entry.mjs");
        else if (!strcmp(command,"run")) args[n++] = local("src/service-entry.mjs");
        else if (strcmp(command,"node")) {args[n++] = local("src/cli.mjs"); args[n++] = (char *)command;}
    } else {
        char *candidate; if (asprintf(&candidate, "runtime/native/%s", command) < 0) die("tool");
        char *file = local(candidate); free(candidate);
        if (!access(file, X_OK)) args[n++] = file;
        else {free(file); args[n++] = local("runtime/native/busybox"); args[n++] = (char *)command;}
    }
    for (int i = skip; i < argc; i++) args[n++] = argv[i];
    args[n] = NULL;
    execv(args[0], args);
    die("failed to launch the bundled runtime");
}
