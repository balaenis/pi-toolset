// ABOUTME: Pi extension that delegates read/write/edit/bash/grep/find/ls tools to a remote machine via SSH.
// ABOUTME: Migrated from the official Pi example (examples/extensions/ssh.ts); --ssh user@host[:/path] runs all file/bash ops on the remote.

import path from 'node:path';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
  GrepToolDetails,
  GrepToolInput,
} from '@earendil-works/pi-coding-agent';
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  DEFAULT_MAX_BYTES,
  type EditOperations,
  type FindOperations,
  formatSize,
  type LsOperations,
  type ReadOperations,
  truncateHead,
  truncateLine,
  type WriteOperations,
} from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import { createSshConnection, type SshChildProcess, type SshConnection } from './ssh.ts';
import {
  createRemoteAtAutocompleteFactory,
  type ListRemoteFiles,
  type RemoteFileEntry,
} from './remote-autocomplete.ts';

interface RemoteOperationContext {
  connection: SshConnection;
  remoteCwd: string;
  localCwd: string;
}

const GREP_DEFAULT_LIMIT = 100;
// Cap for remote fd listings; pure layer re-scores and takes the top REMOTE_AT_MAX_RESULTS.
const REMOTE_LIST_CAP = 100;
// Cap for remote /ssh:cwd directory listings; final candidates are capped separately.
const REMOTE_DIR_LIST_CAP = 100;
// Final /ssh:cwd completion/picker candidate cap: `..` plus at most 99 descendants.
const CWD_CANDIDATE_CAP = 100;

const MATCH_NONE = 0;
const MATCH_ORDERED_SUBSEQUENCE = 1;
const MATCH_FULL_PATH_SUBSTRING = 2;
const MATCH_BASENAME_SUBSTRING = 3;
const MATCH_BASENAME_PREFIX = 4;
const MATCH_EXACT_BASENAME = 5;
const PARENT_ENTRY_COUNT = 1;

// Mirrors pi-tui buildFdPathQuery: path-shaped queries use a separator-tolerant regex for --full-path.
function buildFdPathQuery(query: string): string {
  const normalized = query.replace(/\\/g, '/');
  if (!normalized.includes('/')) return normalized;
  const trimmed = normalized.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return normalized;
  const separatorPattern = '[\\\\/]';
  const segments = trimmed
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (segments.length === 0) return normalized;
  const joined = segments.join(`${separatorPattern}+`);
  return normalized.endsWith('/') ? `${joined}${separatorPattern}` : joined;
}

// Internal marker so failures keep the completed SSH exit status: only remote `test -e`
// status 1 means “missing”; every other failure keeps its transport/process error.
class SshCommandError extends Error {
  constructor(
    message: string,
    readonly exitStatus: number | null,
    readonly stderr: string = ''
  ) {
    super(message);
    this.name = 'SshCommandError';
  }
}

// OpenSSH often emits CR-terminated lines; strip them before UI/tool messages.
function cleanSshText(text: string): string {
  return text.replace(/\r/g, '').trim();
}

// Machine-readable command output: remove only a terminal run of CR/LF, keep valid path spaces.
function stripTrailingLineEndings(value: string): string {
  return value.replace(/[\r\n]+$/, '');
}

// Prefer stderr detail for notifications; fall back to exit status or Error.message.
function formatSshFailureReason(error: unknown): string {
  if (error instanceof SshCommandError) {
    const detail = cleanSshText(error.stderr);
    if (detail) return detail;
    if (error.exitStatus !== null) return `SSH exited with status ${error.exitStatus}`;
    return 'SSH command failed';
  }
  if (error instanceof Error) {
    const message = cleanSshText(error.message);
    return message || 'Unknown error';
  }
  const message = cleanSshText(String(error));
  return message || 'Unknown error';
}

function sshExec(connection: SshConnection, command: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = connection.spawn(command);
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (data) => chunks.push(data));
    child.stderr.on('data', (data) => errChunks.push(data));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        const stderr = cleanSshText(Buffer.concat(errChunks).toString());
        const message = stderr ? `SSH failed (${code}): ${stderr}` : `SSH failed (${code})`;
        reject(new SshCommandError(message, code, stderr));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

function classifyTestExistsError(error: unknown): boolean {
  if (error instanceof SshCommandError && error.exitStatus === 1) return false;
  throw error;
}

function sshExecStream(
  connection: SshConnection,
  command: string,
  onLine: (line: string) => void,
  signal: AbortSignal | undefined,
  onSpawn?: (child: SshChildProcess) => void
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = connection.spawn(command);
    let stderr = '';
    const rl = createInterface({ input: child.stdout });
    rl.on('line', onLine);
    child.stderr.on('data', (data) => (stderr += data.toString()));
    onSpawn?.(child);
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      rl.close();
      resolve({ code, stderr });
    });
  });
}

function normalizeDirPath(raw: string): string | null {
  const rel = raw.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!rel || rel === '.') return null;
  if (rel.split('/').some((segment) => segment === '.git')) return null;
  return rel;
}

function quoteBashArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function mapLocalPathToRemote(value: string, localCwd: string, remoteCwd: string): string {
  return value.replace(localCwd, () => remoteCwd);
}

function buildRemoteDirPrefilter(query: string): string {
  return [...query.toLowerCase()]
    .map((char) => char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'))
    .join('.*');
}

// The awk fallback keeps consuming input after the cap so find never dies from SIGPIPE.
async function listRemoteDirectories(
  ssh: RemoteOperationContext,
  query: string
): Promise<string[]> {
  const { connection, remoteCwd } = ssh;
  const script =
    `set -o pipefail; cd -- "$1" && ` +
    `if command -v fd >/dev/null 2>&1; then ` +
    `if [ -n "$2" ]; then fd --type d --max-results ${REMOTE_DIR_LIST_CAP} --follow --hidden --color=never --exclude .git --exclude '.git/*' --exclude '.git/**' --ignore-case --full-path -- "$2"; ` +
    `else fd --type d --max-results ${REMOTE_DIR_LIST_CAP} --follow --hidden --color=never --exclude .git --exclude '.git/*' --exclude '.git/**'; fi; ` +
    `else find -L . -mindepth 1 \\( -type d -name .git -prune \\) -o \\( -type d -print \\) | ` +
    `awk -v pattern="$2" 'tolower($0) ~ pattern { if (count < ${REMOTE_DIR_LIST_CAP}) print; count += 1 }'; fi`;
  const dirs: string[] = [];
  const seen = new Set<string>();
  const { code, stderr } = await sshExecStream(
    connection,
    `bash -c ${quoteBashArg(script)} -- ${quoteBashArg(remoteCwd)} ${quoteBashArg(buildRemoteDirPrefilter(query))}`,
    (line) => {
      const rel = normalizeDirPath(line);
      if (rel && !seen.has(rel)) {
        seen.add(rel);
        if (dirs.length < REMOTE_DIR_LIST_CAP) dirs.push(rel);
      }
    },
    undefined
  );
  if (code !== 0) {
    throw new Error(stderr.trim() || `remote directory listing failed with code ${code}`);
  }
  return dirs;
}

function isOrderedSubsequence(text: string, query: string): boolean {
  let index = 0;
  for (const char of query) {
    index = text.indexOf(char, index);
    if (index === -1) return false;
    index += 1;
  }
  return true;
}

function dirMatchTier(relativePath: string, query: string): number {
  if (!query) return MATCH_ORDERED_SUBSEQUENCE;
  const lowerQuery = query.toLowerCase();
  const lowerPath = relativePath.toLowerCase();
  const lowerBase = path.basename(relativePath).toLowerCase();
  if (lowerBase === lowerQuery) return MATCH_EXACT_BASENAME;
  if (lowerBase.startsWith(lowerQuery)) return MATCH_BASENAME_PREFIX;
  if (lowerBase.includes(lowerQuery)) return MATCH_BASENAME_SUBSTRING;
  if (lowerPath.includes(lowerQuery)) return MATCH_FULL_PATH_SUBSTRING;
  return isOrderedSubsequence(lowerPath, lowerQuery) ? MATCH_ORDERED_SUBSEQUENCE : MATCH_NONE;
}

// Deterministic Unicode code-point order (no localeCompare): compares scalar values
// numerically, so a supplementary-plane code point sorts after any BMP code point.
function compareCodePoints(a: string, b: string): number {
  const aPoints = [...a];
  const bPoints = [...b];
  const shared = Math.min(aPoints.length, bPoints.length);
  for (let i = 0; i < shared; i += 1) {
    const diff = aPoints[i]!.codePointAt(0)! - bPoints[i]!.codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return aPoints.length - bPoints.length;
}

function rankDirCandidates(paths: string[], query: string): string[] {
  return paths
    .map((p) => ({ path: p, tier: dirMatchTier(p, query) }))
    .filter((candidate) => candidate.tier > MATCH_NONE)
    .sort((a, b) => b.tier - a.tier || compareCodePoints(a.path, b.path))
    .slice(0, CWD_CANDIDATE_CAP - PARENT_ENTRY_COUNT)
    .map((candidate) => candidate.path);
}

async function listRemoteDirCandidates(
  ssh: RemoteOperationContext,
  prefix: string
): Promise<AutocompleteItem[]> {
  const dirs = await listRemoteDirectories(ssh, prefix);
  const items: AutocompleteItem[] = [{ value: '..', label: '..' }];
  for (const rel of rankDirCandidates(dirs, prefix)) {
    const label = path.basename(rel);
    items.push({ value: rel, label, description: label === rel ? undefined : rel });
  }
  return items;
}

// Quoted positional arguments do not perform tilde expansion, so the script resolves ~ itself.
async function resolveRemoteCwd(ssh: RemoteOperationContext, target: string): Promise<string> {
  const script =
    `case "$2" in "~") target=$HOME ;; "~/"*) target=$HOME/\${2#\\~/} ;; *) target=$2 ;; esac; ` +
    `cd -- "$1" && cd -- "$target" && pwd`;
  const output = await sshExec(
    ssh.connection,
    `bash -c ${quoteBashArg(script)} -- ${quoteBashArg(ssh.remoteCwd)} ${quoteBashArg(target)}`
  );
  const cwd = stripTrailingLineEndings(output.toString());
  if (!cwd) throw new Error('remote pwd returned an empty path');
  if (!path.posix.isAbsolute(cwd))
    throw new Error(`remote pwd returned a non-absolute path: ${cwd}`);
  return cwd;
}

async function switchRemoteCwd(
  ssh: RemoteOperationContext,
  ctx: ExtensionCommandContext,
  target: string,
  getCurrentSsh: () => RemoteOperationContext | null
): Promise<void> {
  let cwd: string;
  try {
    cwd = await resolveRemoteCwd(ssh, target);
  } catch (error) {
    if (getCurrentSsh() !== ssh) {
      ctx.ui.notify('Remote working directory switch superseded by a new connection.', 'warning');
      return;
    }
    ctx.ui.notify(`Cannot change remote cwd: ${formatSshFailureReason(error)}`, 'error');
    return;
  }
  if (getCurrentSsh() !== ssh) {
    ctx.ui.notify('Remote working directory switch superseded by a new connection.', 'warning');
    return;
  }
  ssh.remoteCwd = cwd;
  ctx.ui.setStatus('ssh', ctx.ui.theme.fg('accent', `SSH: ${ssh.connection.remote}:${cwd}`));
  ctx.ui.notify(`Remote working directory: ${cwd}`, 'info');
}

function createRemoteReadOps({
  connection,
  remoteCwd,
  localCwd,
}: RemoteOperationContext): ReadOperations {
  const toRemote = (p: string) => mapLocalPathToRemote(p, localCwd, remoteCwd);
  return {
    readFile: (p) => sshExec(connection, `cat -- ${quoteBashArg(toRemote(p))}`),
    access: (p) => sshExec(connection, `test -r ${quoteBashArg(toRemote(p))}`).then(() => {}),
    detectImageMimeType: async (p) => {
      try {
        const r = await sshExec(connection, `file --mime-type -b ${quoteBashArg(toRemote(p))}`);
        const m = r.toString().trim();
        return ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(m) ? m : null;
      } catch {
        return null;
      }
    },
  };
}

function createRemoteWriteOps({
  connection,
  remoteCwd,
  localCwd,
}: RemoteOperationContext): WriteOperations {
  const toRemote = (p: string) => mapLocalPathToRemote(p, localCwd, remoteCwd);
  return {
    writeFile: async (p, content) => {
      const b64 = Buffer.from(content).toString('base64');
      await sshExec(
        connection,
        `printf %s ${quoteBashArg(b64)} | base64 -d > ${quoteBashArg(toRemote(p))}`
      );
    },
    mkdir: (dir) =>
      sshExec(connection, `mkdir -p -- ${quoteBashArg(toRemote(dir))}`).then(() => {}),
  };
}

function createRemoteEditOps(ctx: RemoteOperationContext): EditOperations {
  const r = createRemoteReadOps(ctx);
  const w = createRemoteWriteOps(ctx);
  return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function createRemoteBashOps({
  connection,
  remoteCwd,
  localCwd,
}: RemoteOperationContext): BashOperations {
  const toRemote = (p: string) => mapLocalPathToRemote(p, localCwd, remoteCwd);
  return {
    exec: (command, cwd, { onData, signal, timeout }) =>
      new Promise((resolve, reject) => {
        const cmd = `cd -- ${quoteBashArg(toRemote(cwd))} && ${command}`;
        const child = connection.spawn(cmd);
        let timedOut = false;
        const timer = timeout
          ? setTimeout(() => {
              timedOut = true;
              child.kill();
            }, timeout * 1000)
          : undefined;
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        });
        const onAbort = () => child.kill();
        signal?.addEventListener('abort', onAbort, { once: true });
        child.on('close', (code) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (signal?.aborted) reject(new Error('aborted'));
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else resolve({ exitCode: code });
        });
      }),
  };
}

// The built-in grep tool spawns rg locally, so SSH mode needs its own implementation that runs rg on the remote.
function createRemoteGrepExec({ connection, remoteCwd, localCwd }: RemoteOperationContext) {
  const toRemote = (p: string) => mapLocalPathToRemote(p, localCwd, remoteCwd);
  return async (
    params: GrepToolInput,
    signal: AbortSignal | undefined
  ): Promise<AgentToolResult<GrepToolDetails>> => {
    if (signal?.aborted) throw new Error('Operation aborted');
    const searchPath = toRemote(path.resolve(localCwd, params.path || '.'));
    const contextValue = params.context && params.context > 0 ? params.context : 0;
    const effectiveLimit = Math.max(1, params.limit ?? GREP_DEFAULT_LIMIT);

    const args = ['--json', '--line-number', '--color=never', '--hidden'];
    if (params.ignoreCase) args.push('--ignore-case');
    if (params.literal) args.push('--fixed-strings');
    if (params.glob) args.push('--glob', params.glob);
    if (contextValue > 0) args.push('-C', String(contextValue));
    args.push('--', params.pattern, searchPath);

    const formatPath = (filePath: string) => {
      const relative = path.relative(searchPath, filePath);
      if (relative && !relative.startsWith('..')) return relative.replace(/\\/g, '/');
      return path.basename(filePath);
    };

    let matchCount = 0;
    let matchLimitReached = false;
    let linesTruncated = false;
    const outputLines: string[] = [];
    let kill: (() => void) | undefined;

    const { code, stderr } = await sshExecStream(
      connection,
      `rg ${args.map((a) => quoteBashArg(a)).join(' ')}`,
      (line) => {
        if (!line.trim() || matchCount >= effectiveLimit) return;
        let event: {
          type?: string;
          data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
        };
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type !== 'match' && event.type !== 'context') return;
        const filePath = event.data?.path?.text ?? '';
        const lineNumber = event.data?.line_number;
        if (typeof lineNumber !== 'number') return;
        const lineText = (event.data?.lines?.text ?? '')
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '')
          .replace(/\n$/, '');
        const { text, wasTruncated } = truncateLine(lineText);
        if (wasTruncated) linesTruncated = true;
        if (event.type === 'match') {
          matchCount++;
          outputLines.push(`${formatPath(filePath)}:${lineNumber}: ${text}`);
          if (matchCount >= effectiveLimit) {
            matchLimitReached = true;
            kill?.();
          }
        } else {
          outputLines.push(`${formatPath(filePath)}-${lineNumber}- ${text}`);
        }
      },
      signal,
      (child) => {
        kill = () => child.kill();
      }
    );

    if (signal?.aborted) throw new Error('Operation aborted');
    if (!matchLimitReached && code !== 0 && code !== 1) {
      throw new Error(stderr.trim() || `rg exited with code ${code}`);
    }
    if (matchCount === 0) {
      return { content: [{ type: 'text', text: 'No matches found' }], details: {} };
    }

    const rawOutput = outputLines.join('\n');
    // Match limit already capped rows; only byte truncation applies here.
    const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
    let output = truncation.content;
    const details: GrepToolDetails = {};
    const notices: string[] = [];
    if (matchLimitReached) {
      notices.push(
        `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`
      );
      details.matchLimitReached = effectiveLimit;
    }
    if (truncation.truncated) {
      notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      details.truncation = truncation;
    }
    if (linesTruncated) {
      notices.push('Some lines truncated to 500 chars. Use read tool to see full lines');
      details.linesTruncated = true;
    }
    if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`;
    return {
      content: [{ type: 'text', text: output }],
      details,
    };
  };
}

function createRemoteLsOps({
  connection,
  remoteCwd,
  localCwd,
}: RemoteOperationContext): LsOperations {
  const toRemote = (p: string) => mapLocalPathToRemote(p, localCwd, remoteCwd);
  return {
    exists: (p) =>
      sshExec(connection, `test -e ${quoteBashArg(toRemote(p))}`).then(
        () => true,
        classifyTestExistsError
      ),
    stat: async (p) => {
      const kind = (
        await sshExec(
          connection,
          `if test -d ${quoteBashArg(toRemote(p))}; then echo dir; elif test -e ${quoteBashArg(toRemote(p))}; then echo file; else echo missing; fi`
        )
      )
        .toString()
        .trim();
      if (kind === 'dir') return { isDirectory: () => true };
      if (kind === 'file') return { isDirectory: () => false };
      throw new Error(`Path not found: ${p}`);
    },
    // -A includes dotfiles but omits . and ..; the tool sorts entries and stats each for the / suffix.
    readdir: (p) =>
      sshExec(connection, `ls -1A -- ${quoteBashArg(toRemote(p))}`).then((r) =>
        r
          .toString()
          .split('\n')
          .filter((line) => line.length > 0)
      ),
  };
}

// Lists remote files and directories via fd (same shape as local pi-tui @ completion).
// Two typed passes in one SSH session so directories are first-class (not inferred from files).
// Errors and aborts surface as an empty list, never a throw.
function createSshRemoteFileLister(connection: SshConnection): ListRemoteFiles {
  return async ({ searchRoot, query, signal }) => {
    const common = [
      '--base-directory',
      searchRoot,
      '--max-results',
      String(REMOTE_LIST_CAP),
      '--follow',
      '--hidden',
      '--color=never',
      '--exclude',
      '.git',
      '--exclude',
      '.git/*',
      '--exclude',
      '.git/**',
    ];
    if (query.replace(/\\/g, '/').includes('/')) {
      common.push('--full-path');
    }
    if (query) {
      common.push(buildFdPathQuery(query));
    }
    const q = common.map((a) => quoteBashArg(a)).join(' ');
    // Prefix lines with "1 " (dir) / "0 " (file); fd does not emit a trailing-/ on directories.
    const script =
      `set -o pipefail; ` +
      `fd --type d ${q} | sed 's|^\\./||; s|^|1 |'; ` +
      `fd --type f ${q} | sed 's|^\\./||; s|^|0 |'`;
    const entries: RemoteFileEntry[] = [];
    const { code } = await sshExecStream(
      connection,
      `bash -c ${quoteBashArg(script)}`,
      (line) => {
        if (line.length < 3 || (line[0] !== '0' && line[0] !== '1') || line[1] !== ' ') return;
        const isDirectory = line[0] === '1';
        const rel = line.slice(2).replace(/\\/g, '/').replace(/\/+$/, '');
        if (!rel || rel === '.git' || rel.startsWith('.git/') || rel.includes('/.git/')) return;
        entries.push({ relativePath: rel, isDirectory });
      },
      signal
    );
    if (signal?.aborted) return [];
    if (entries.length === 0 && code !== 0 && code !== 1) {
      return [];
    }
    return entries;
  };
}

function createRemoteFindOps({
  connection,
  remoteCwd,
  localCwd,
}: RemoteOperationContext): FindOperations {
  const toRemote = (p: string) => mapLocalPathToRemote(p, localCwd, remoteCwd);
  return {
    exists: (p) =>
      sshExec(connection, `test -e ${quoteBashArg(toRemote(p))}`).then(
        () => true,
        classifyTestExistsError
      ),
    // Runs rg --files on the remote (rg is already required for grep). Globs follow gitignore-style
    // semantics, equivalent to fd --full-path. Output is relative so the tool can relativize it
    // against the local search path. pipefail surfaces rg failures (e.g. missing binary).
    glob: async (pattern, cwd, { ignore, limit }) => {
      const globs = [pattern, ...ignore.map((i) => `!${i}`)]
        .map((g) => `-g ${quoteBashArg(g)}`)
        .join(' ');
      const script =
        `set -o pipefail; cd -- ${quoteBashArg(toRemote(cwd))} && ` +
        `rg --files --hidden --color=never ${globs} -- . | head -n ${limit}`;
      const lines: string[] = [];
      const { code, stderr } = await sshExecStream(
        connection,
        `bash -c ${quoteBashArg(script)}`,
        (line) => lines.push(line),
        undefined
      );
      if (lines.length === 0 && code !== 0 && code !== 1) {
        throw new Error(stderr.trim() || `rg exited with code ${code}`);
      }
      return lines;
    },
  };
}

export interface PiRemoteDependencies {
  createSshConnection: typeof createSshConnection;
}

interface ParsedTarget {
  remote: string;
  path: string | undefined;
  port: number | undefined;
}

// Reads SSH host aliases from ~/.ssh/config. Skips wildcards and negated patterns so
// every returned alias is directly usable as `ssh <alias>`.
function readSshConfigHosts(): string[] {
  const configPath = path.join(os.homedir(), '.ssh', 'config');
  let content: string;
  try {
    content = readFileSync(configPath, 'utf8');
  } catch {
    return [];
  }
  const hosts: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^Host\s+(.+)$/);
    if (!match) continue;
    const alias = match[1]!.trim().split(/\s+/)[0]!;
    if (!alias || /[*?!]/.test(alias)) continue;
    hosts.push(alias);
  }
  return [...new Set(hosts)];
}

// Parses `/ssh user@host [:/path] [-p PORT]` (also accepts -pPORT, -p=PORT, --port).
function parseRemoteTarget(args: string): ParsedTarget | null {
  const tokens = args.trim().split(/\s+/);
  let port: number | undefined;
  const hostTokens: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === '-p' || token === '--port') {
      const next = tokens[i + 1];
      if (next && /^\d+$/.test(next)) {
        port = Number(next);
        i += 1;
      } else {
        return null;
      }
      continue;
    }
    const inline = token.match(/^(?:-p|--port)=?(\d+)$/);
    if (inline) {
      port = Number(inline[1]);
      continue;
    }
    hostTokens.push(token);
  }
  const target = hostTokens.join('');
  if (!target) return null;
  const sep = target.indexOf(':');
  const remote = sep === -1 ? target : target.slice(0, sep);
  const sshPath = sep === -1 ? undefined : target.slice(sep + 1);
  if (!remote) return null;
  return { remote, path: sshPath, port };
}

export function registerPiRemote(pi: ExtensionAPI, dependencies: PiRemoteDependencies) {
  pi.registerFlag('ssh', {
    description: 'SSH remote: user@host or user@host:/path',
    type: 'string',
  });

  const localCwd = process.cwd();
  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);
  const localGrep = createGrepTool(localCwd);
  const localFind = createFindTool(localCwd);
  const localLs = createLsTool(localCwd);

  // Resolved lazily on session_start (CLI flags not available during factory)
  let resolvedSsh: RemoteOperationContext | null = null;
  let sshFailure: string | null = null;

  // Throws when --ssh was given but the remote could not be reached, so tools
  // never silently fall back to local execution in that case.
  const getSsh = () => {
    if (sshFailure) throw new Error(`SSH mode unavailable: ${sshFailure}`);
    return resolvedSsh;
  };

  // Registers the SSH-backed tools. Only called after the remote has been reached,
  // so the ssh context is guaranteed non-null and no local fallback is needed.
  const registerSshTools = (ssh: RemoteOperationContext) => {
    pi.registerTool({
      ...localRead,
      async execute(id, params, signal, onUpdate) {
        return createReadTool(localCwd, {
          operations: createRemoteReadOps(ssh),
        }).execute(id, params, signal, onUpdate);
      },
    });

    pi.registerTool({
      ...localWrite,
      async execute(id, params, signal, onUpdate) {
        return createWriteTool(localCwd, {
          operations: createRemoteWriteOps(ssh),
        }).execute(id, params, signal, onUpdate);
      },
    });

    pi.registerTool({
      ...localEdit,
      async execute(id, params, signal, onUpdate) {
        return createEditTool(localCwd, {
          operations: createRemoteEditOps(ssh),
        }).execute(id, params, signal, onUpdate);
      },
    });

    pi.registerTool({
      ...localBash,
      async execute(id, params, signal, onUpdate) {
        return createBashTool(localCwd, {
          operations: createRemoteBashOps(ssh),
        }).execute(id, params, signal, onUpdate);
      },
    });

    pi.registerTool({
      ...localGrep,
      async execute(_id, params, signal, _onUpdate) {
        return createRemoteGrepExec(ssh)(params, signal);
      },
    });

    pi.registerTool({
      ...localFind,
      async execute(id, params, signal, onUpdate) {
        return createFindTool(localCwd, {
          operations: createRemoteFindOps(ssh),
        }).execute(id, params, signal, onUpdate);
      },
    });

    pi.registerTool({
      ...localLs,
      async execute(id, params, signal, onUpdate) {
        return createLsTool(localCwd, {
          operations: createRemoteLsOps(ssh),
        }).execute(id, params, signal, onUpdate);
      },
    });
  };

  let autocompleteRegistered = false;

  // Connects to a remote, wires the SSH-backed tools, and updates UI. Reused by
  // session_start (--ssh flag) and the /ssh command. On failure it keeps any working
  // previous connection instead of leaving the session half-configured.
  const connectSsh = async (
    ui: ExtensionUIContext,
    remote: string,
    sshPath?: string,
    port?: number
  ): Promise<boolean> => {
    const previous = resolvedSsh;
    let connection: SshConnection | undefined;
    try {
      connection = await dependencies.createSshConnection(remote, {}, port);
      const remoteCwd = sshPath ?? (await sshExec(connection, 'pwd')).toString().trim();
      const sshContext: RemoteOperationContext = { connection, remoteCwd, localCwd };
      resolvedSsh = sshContext;
      sshFailure = null;
      registerSshTools(sshContext);
      if (!autocompleteRegistered) {
        ui.addAutocompleteProvider(
          createRemoteAtAutocompleteFactory({
            getSsh: () => resolvedSsh,
            localCwd,
            listRemoteFiles: (request) => {
              const conn = resolvedSsh?.connection;
              return conn ? createSshRemoteFileLister(conn)(request) : Promise.resolve([]);
            },
          })
        );
        autocompleteRegistered = true;
      }
      ui.setStatus('ssh', ui.theme.fg('accent', `SSH: ${connection.remote}:${remoteCwd}`));
      if (previous && previous !== sshContext) {
        await previous.connection.close().catch(() => {});
      }
      return true;
    } catch (e) {
      // Surface the cleaned SSH reason as an error notification so the TUI never
      // only shows raw /dev/tty prompts or a silent hang.
      const reason = formatSshFailureReason(e);
      if (previous) {
        // Keep the previous working connection fully functional.
        resolvedSsh = previous;
        sshFailure = null;
        ui.notify(
          `SSH connection failed: ${remote}: ${reason} (kept previous connection)`,
          'error'
        );
      } else {
        resolvedSsh = null;
        sshFailure = reason;
        ui.notify(`SSH connection failed: cannot reach ${remote}: ${reason}`, 'error');
        ui.setStatus('ssh', ui.theme.fg('error', `SSH failed: ${remote}`));
      }
      await connection?.close().catch(() => {});
      return false;
    }
  };

  pi.on('session_start', async (_event, ctx) => {
    // Resolve SSH config now that CLI flags are available
    const arg = pi.getFlag('ssh') as string | undefined;
    if (!arg) return;
    const [remote, sshPath] = arg.split(':');
    await connectSsh(ctx.ui, remote, sshPath);
  });

  pi.on('session_shutdown', async () => {
    const connection = resolvedSsh?.connection;
    resolvedSsh = null;
    sshFailure = null;
    if (connection) {
      await connection.close();
    }
  });

  // Handle user ! commands via SSH
  pi.on('user_bash', () => {
    const ssh = getSsh();
    if (!ssh) return; // No SSH, use local execution
    return { operations: createRemoteBashOps(ssh) };
  });

  // Replace local cwd with remote cwd in system prompt
  pi.on('before_agent_start', async (event) => {
    // Non-throwing accessor: on failure keep the local prompt (tools will error loudly).
    const ssh = !sshFailure ? resolvedSsh : null;
    if (ssh) {
      const append = `
[SSH Mode]
Connected to a remote host \`${ssh.connection.remote}\` over SSH.
Unless noted otherwise, file paths and commands refer to the remote host.
Remote working directory: \`${ssh.remoteCwd}\`
`;
      return { systemPrompt: `${event.systemPrompt}\n\n${append}` };
    }
  });

  // Interactive connect: no args → pick from ~/.ssh/config; otherwise parse a manual target.
  pi.registerCommand('ssh', {
    description:
      'Connect to a remote via SSH. No args: pick from ~/.ssh/config. Or /ssh user@host [:/path] [-p PORT]',
    getArgumentCompletions: (prefix: string) => {
      const items = readSshConfigHosts().map((host) => ({ value: host, label: host }));
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        const hosts = readSshConfigHosts();
        if (hosts.length === 0) {
          ctx.ui.notify('No hosts in ~/.ssh/config. Use /ssh user@host [-p PORT]', 'warning');
          return;
        }
        const target =
          hosts.length === 1 ? hosts[0]! : await ctx.ui.select('Select SSH host', hosts);
        if (!target) return;
        await connectSsh(ctx.ui, target);
        return;
      }
      const parsed = parseRemoteTarget(trimmed);
      if (!parsed) {
        ctx.ui.notify('Invalid target. Use /ssh user@host [:/path] [-p PORT]', 'error');
        return;
      }
      await connectSsh(ctx.ui, parsed.remote, parsed.path, parsed.port);
    },
  });

  pi.registerCommand('ssh:cwd', {
    description: 'Change the remote working directory for SSH-backed tools',
    getArgumentCompletions: (prefix: string) => {
      const ssh = resolvedSsh;
      if (!ssh) return null;
      return listRemoteDirCandidates(ssh, prefix).catch(() => null);
    },
    handler: async (args, ctx) => {
      const ssh = resolvedSsh;
      if (!ssh) {
        ctx.ui.notify('No active SSH connection. Use /ssh first.', 'error');
        return;
      }
      if (!args) {
        let items: AutocompleteItem[];
        try {
          items = await listRemoteDirCandidates(ssh, '');
        } catch (error) {
          ctx.ui.notify(
            `Could not list remote directories: ${formatSshFailureReason(error)}`,
            'error'
          );
          return;
        }
        const selected = await ctx.ui.select(
          `Select remote directory under ${ssh.remoteCwd}`,
          items.map((item) => item.value)
        );
        if (!selected) return;
        await switchRemoteCwd(ssh, ctx, selected, () => resolvedSsh);
        return;
      }
      await switchRemoteCwd(ssh, ctx, args, () => resolvedSsh);
    },
  });
}

export default function (pi: ExtensionAPI) {
  return registerPiRemote(pi, { createSshConnection });
}
