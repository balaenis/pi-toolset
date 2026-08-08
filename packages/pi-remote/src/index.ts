// ABOUTME: Pi extension that delegates read/write/edit/bash/grep/find/ls tools to a remote machine via SSH.
// ABOUTME: Migrated from the official Pi example (examples/extensions/ssh.ts); --ssh user@host[:/path] runs all file/bash ops on the remote.

import path from 'node:path';
import { createInterface } from 'node:readline';
import type {
  AgentToolResult,
  ExtensionAPI,
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
    readonly exitStatus: number | null
  ) {
    super(message);
    this.name = 'SshCommandError';
  }
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
        reject(
          new SshCommandError(`SSH failed (${code}): ${Buffer.concat(errChunks).toString()}`, code)
        );
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

// Streams stdout lines from a remote command; resolves with exit code and stderr (no zero-exit requirement).
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

function createRemoteReadOps({
  connection,
  remoteCwd,
  localCwd,
}: RemoteOperationContext): ReadOperations {
  const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
  return {
    readFile: (p) => sshExec(connection, `cat ${JSON.stringify(toRemote(p))}`),
    access: (p) => sshExec(connection, `test -r ${JSON.stringify(toRemote(p))}`).then(() => {}),
    detectImageMimeType: async (p) => {
      try {
        const r = await sshExec(connection, `file --mime-type -b ${JSON.stringify(toRemote(p))}`);
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
  const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
  return {
    writeFile: async (p, content) => {
      const b64 = Buffer.from(content).toString('base64');
      await sshExec(
        connection,
        `echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(toRemote(p))}`
      );
    },
    mkdir: (dir) => sshExec(connection, `mkdir -p ${JSON.stringify(toRemote(dir))}`).then(() => {}),
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
  const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
  return {
    exec: (command, cwd, { onData, signal, timeout }) =>
      new Promise((resolve, reject) => {
        const cmd = `cd ${JSON.stringify(toRemote(cwd))} && ${command}`;
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
  const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
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
      `rg ${args.map((a) => JSON.stringify(a)).join(' ')}`,
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
  const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
  return {
    exists: (p) =>
      sshExec(connection, `test -e ${JSON.stringify(toRemote(p))}`).then(
        () => true,
        classifyTestExistsError
      ),
    stat: async (p) => {
      const kind = (
        await sshExec(
          connection,
          `if test -d ${JSON.stringify(toRemote(p))}; then echo dir; elif test -e ${JSON.stringify(toRemote(p))}; then echo file; else echo missing; fi`
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
      sshExec(connection, `ls -1A ${JSON.stringify(toRemote(p))}`).then((r) =>
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
    const q = common.map((a) => JSON.stringify(a)).join(' ');
    // Prefix lines with "1 " (dir) / "0 " (file); fd does not emit a trailing-/ on directories.
    const script =
      `set -o pipefail; ` +
      `fd --type d ${q} | sed 's|^\\./||; s|^|1 |'; ` +
      `fd --type f ${q} | sed 's|^\\./||; s|^|0 |'`;
    const entries: RemoteFileEntry[] = [];
    const { code } = await sshExecStream(
      connection,
      `bash -c ${JSON.stringify(script)}`,
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
  const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
  return {
    exists: (p) =>
      sshExec(connection, `test -e ${JSON.stringify(toRemote(p))}`).then(
        () => true,
        classifyTestExistsError
      ),
    // Runs rg --files on the remote (rg is already required for grep). Globs follow gitignore-style
    // semantics, equivalent to fd --full-path. Output is relative so the tool can relativize it
    // against the local search path. pipefail surfaces rg failures (e.g. missing binary).
    glob: async (pattern, cwd, { ignore, limit }) => {
      const globs = [pattern, ...ignore.map((i) => `!${i}`)]
        .map((g) => `-g ${JSON.stringify(g)}`)
        .join(' ');
      const script =
        `set -o pipefail; cd ${JSON.stringify(toRemote(cwd))} && ` +
        `rg --files --hidden --color=never ${globs} -- . | head -n ${limit}`;
      const lines: string[] = [];
      const { code, stderr } = await sshExecStream(
        connection,
        `bash -c ${JSON.stringify(script)}`,
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

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate) {
      const ssh = getSsh();
      if (ssh) {
        const tool = createReadTool(localCwd, {
          operations: createRemoteReadOps(ssh),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localRead.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate) {
      const ssh = getSsh();
      if (ssh) {
        const tool = createWriteTool(localCwd, {
          operations: createRemoteWriteOps(ssh),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localWrite.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate) {
      const ssh = getSsh();
      if (ssh) {
        const tool = createEditTool(localCwd, {
          operations: createRemoteEditOps(ssh),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localEdit.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate) {
      const ssh = getSsh();
      if (ssh) {
        const tool = createBashTool(localCwd, {
          operations: createRemoteBashOps(ssh),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localBash.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localGrep,
    async execute(id, params, signal, onUpdate) {
      const ssh = getSsh();
      if (ssh) {
        return createRemoteGrepExec(ssh)(params, signal);
      }
      return localGrep.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localFind,
    async execute(id, params, signal, onUpdate) {
      const ssh = getSsh();
      if (ssh) {
        const tool = createFindTool(localCwd, {
          operations: createRemoteFindOps(ssh),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localFind.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localLs,
    async execute(id, params, signal, onUpdate) {
      const ssh = getSsh();
      if (ssh) {
        const tool = createLsTool(localCwd, {
          operations: createRemoteLsOps(ssh),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localLs.execute(id, params, signal, onUpdate);
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    // Resolve SSH config now that CLI flags are available
    const arg = pi.getFlag('ssh') as string | undefined;
    if (!arg) return;
    const [remote, path] = arg.split(':');
    let connection: SshConnection | undefined;
    try {
      connection = await dependencies.createSshConnection(remote);
      let remoteCwd: string;
      if (path) {
        remoteCwd = path;
      } else {
        // No path given, evaluate pwd on remote
        remoteCwd = (await sshExec(connection, 'pwd')).toString().trim();
      }
      resolvedSsh = { connection, remoteCwd, localCwd };
    } catch (e) {
      // Surface the failure instead of silently falling back to local tools
      resolvedSsh = null;
      const msg = e instanceof Error ? e.message : String(e);
      sshFailure = msg;
      ctx.ui.notify(`SSH mode failed: cannot reach ${remote}: ${msg}`, 'error');
      ctx.ui.setStatus('ssh', ctx.ui.theme.fg('error', `SSH failed: ${remote}`));
      try {
        await connection?.close();
      } catch {
        // Cleanup is best-effort on failed startup; keep the original SSH failure.
      }
      return;
    }
    ctx.ui.addAutocompleteProvider(
      createRemoteAtAutocompleteFactory({
        getSsh: () => (!sshFailure ? resolvedSsh : null),
        localCwd,
        listRemoteFiles: createSshRemoteFileLister(connection),
      })
    );
    ctx.ui.setStatus(
      'ssh',
      ctx.ui.theme.fg('accent', `SSH: ${connection.remote}:${resolvedSsh.remoteCwd}`)
    );
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
      const line = `Current working directory: ${ssh.remoteCwd} (via SSH: ${ssh.connection.remote})`;
      // Replace whatever cwd line the prompt carries (format-tolerant); append if absent.
      const modified = event.systemPrompt.replace(/Current working directory: .*/, line);
      return { systemPrompt: modified.includes(line) ? modified : `${modified}\n${line}` };
    }
  });
}

export default function (pi: ExtensionAPI) {
  return registerPiRemote(pi, { createSshConnection });
}
