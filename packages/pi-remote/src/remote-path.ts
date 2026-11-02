// ABOUTME: Maps local tool paths onto remote POSIX paths.
// ABOUTME: Keeps Windows separators and drive prefixes out of SSH commands.

import path from 'node:path';

function withForwardSlashes(value: string): string {
  return value.replaceAll('\\', '/');
}

function stripTrailingSlashes(value: string): string {
  if (value.length <= 1) return value;
  return value.replace(/\/+$/, '');
}

/** Rewrite a local absolute path to the remote cwd. Unrelated paths stay unchanged. */
export function mapLocalPathToRemote(value: string, localCwd: string, remoteCwd: string): string {
  const normalizedValue = withForwardSlashes(value);
  const localPrefix = stripTrailingSlashes(withForwardSlashes(localCwd));
  const comparableValue =
    process.platform === 'win32' ? normalizedValue.toLowerCase() : normalizedValue;
  const comparablePrefix = process.platform === 'win32' ? localPrefix.toLowerCase() : localPrefix;

  if (comparableValue === comparablePrefix) return remoteCwd;
  const prefixWithSlash = `${comparablePrefix}/`;
  if (comparableValue.startsWith(prefixWithSlash)) {
    return `${remoteCwd}${normalizedValue.slice(localPrefix.length)}`;
  }
  return value;
}

/** Resolve a tool or `@` path against the remote cwd using POSIX rules. */
export function resolveRemotePath(target: string, localCwd: string, remoteCwd: string): string {
  if (target === '' || target === '.') return remoteCwd;
  const posixTarget = withForwardSlashes(target);
  if (path.posix.isAbsolute(posixTarget) || path.isAbsolute(target)) {
    return stripTrailingSlashes(mapLocalPathToRemote(target, localCwd, remoteCwd));
  }
  return stripTrailingSlashes(path.posix.join(remoteCwd, posixTarget));
}
