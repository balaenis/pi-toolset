// ABOUTME: Filters LSP location results against .gitignore using `git check-ignore`.
// ABOUTME: Port of Claude Code's filterGitIgnoredLocations, batched with a 5s timeout.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Location } from 'vscode-languageserver-types';
import { logForDebugging } from './log.ts';

const execFileAsync = promisify(execFile);

const BATCH_SIZE = 50;
const TIMEOUT_MS = 5_000;

/**
 * Convert a file:// URI to a filesystem path, decoding percent-encoding and
 * stripping the Windows drive-letter leading slash.
 */
function uriToFilePath(uri: string): string {
  let filePath = uri.replace(/^file:\/\//, '');
  if (/^\/[A-Za-z]:/.test(filePath)) {
    filePath = filePath.slice(1);
  }
  try {
    filePath = decodeURIComponent(filePath);
  } catch {
    // Use un-decoded path if malformed.
  }
  return filePath;
}

/**
 * Filter out locations whose file paths are gitignored.
 *
 * Runs `git check-ignore` in batches of {@link BATCH_SIZE} paths with a
 * {@link TIMEOUT_MS} timeout, rooted at `cwd`. Exit code 0 means at least one
 * path in the batch is ignored (the ignored paths are printed to stdout);
 * exit 1 means none ignored; exit 128 means not a git repository (no
 * filtering applied). Errors and timeouts fall through to "no filtering" so
 * LSP results are never dropped due to a git failure.
 */
export async function filterGitIgnoredLocations<T extends Location>(
  locations: T[],
  cwd: string
): Promise<T[]> {
  if (locations.length === 0) return locations;

  const uriToPath = new Map<string, string>();
  for (const loc of locations) {
    if (loc.uri && !uriToPath.has(loc.uri)) {
      uriToPath.set(loc.uri, uriToFilePath(loc.uri));
    }
  }

  const uniquePaths = Array.from(new Set(uriToPath.values()));
  if (uniquePaths.length === 0) return locations;

  const ignoredPaths = new Set<string>();
  for (let i = 0; i < uniquePaths.length; i += BATCH_SIZE) {
    const batch = uniquePaths.slice(i, i + BATCH_SIZE);
    try {
      const { stdout } = await execFileAsync('git', ['check-ignore', ...batch], {
        cwd,
        timeout: TIMEOUT_MS,
      });
      if (stdout) {
        for (const line of stdout.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) ignoredPaths.add(trimmed);
        }
      }
    } catch (error) {
      // Exit code 1 (nothing ignored) and 128 (not a git repo) both land here;
      // either way the batch is treated as "no paths ignored". Genuine errors
      // (timeout, git missing) also fall through so results stay intact.
      logForDebugging(`gitignore: git check-ignore batch skipped: ${(error as Error).message}`, {
        level: 'warn',
      });
    }
  }

  if (ignoredPaths.size === 0) return locations;

  return locations.filter((loc) => {
    const filePath = uriToPath.get(loc.uri);
    return !filePath || !ignoredPaths.has(filePath);
  });
}
