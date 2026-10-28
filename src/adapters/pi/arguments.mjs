const managementCommands = new Set(['auth', 'config', 'install', 'remove', 'uninstall', 'update', 'list', 'mcp']);

// Keep Pi's own prompt, context-file and project-trust defaults. Only bundled
// extensions are added for interactive and RPC sessions.
export function forwardedArguments(args, extensions) {
  if (managementCommands.has(args[0])) return [...args];
  const list = Array.isArray(extensions) ? extensions : [extensions];
  return [...list.flatMap(extension => ['--extension', extension]), ...args];
}
