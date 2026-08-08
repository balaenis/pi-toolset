// ABOUTME: Owns one OpenSSH multiplexed connection per session: safe control paths, centralized spawning, cleanup.
// ABOUTME: The process boundary is injectable so unit tests never run a live ssh client.
import { spawn, type StdioOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';

const CONTROL_PATH_MAX_BYTES = 100;
const PRIVATE_DIR_PREFIX = 'pi-r-';
const TARGET_HASH_LENGTH = 16;
const SERVER_ALIVE_INTERVAL = '15';
const SERVER_ALIVE_COUNT_MAX = '3';
const CONNECT_TIMEOUT = '15';
const CONNECTION_ATTEMPTS = '2';

export const CONTROL_PERSIST = '10m';

export interface SshControlPath {
  directory: string;
  socketPath: string;
}

export type SshChildProcess = import('node:child_process').ChildProcessByStdio<
  null,
  Readable,
  Readable
>;

export interface SshRuntimeDependencies {
  env?: NodeJS.ProcessEnv;
  processId?: number;
  getUid?: () => number | undefined;
  temporaryDirectory?: string;
  spawnProcess?: typeof spawn;
}

async function isSafeRuntimeDir(dir: string, uid: number): Promise<boolean> {
  if (!dir || !path.isAbsolute(dir)) return false;
  try {
    const directoryStats = await stat(dir);
    if (!directoryStats.isDirectory()) return false;
    // Reject group/other write bits so a peer cannot tamper with the socket.
    if ((directoryStats.mode & 0o022) !== 0) return false;
    if (directoryStats.uid !== uid) return false;
    return true;
  } catch {
    return false;
  }
}

export async function createSshControlPath(
  remote: string,
  dependencies: SshRuntimeDependencies = {}
): Promise<SshControlPath> {
  const env = dependencies.env ?? process.env;
  const processId = dependencies.processId ?? process.pid;
  const uid = dependencies.getUid ? dependencies.getUid() : process.getuid?.();
  const temporaryDirectory = dependencies.temporaryDirectory ?? os.tmpdir();

  const bases: string[] = [];
  const xdg = env.XDG_RUNTIME_DIR;
  if (uid !== undefined && typeof xdg === 'string' && (await isSafeRuntimeDir(xdg, uid))) {
    bases.push(xdg);
  }
  if (temporaryDirectory) bases.push(temporaryDirectory);

  for (const base of [...new Set(bases)]) {
    try {
      return await createPrivateControlPath(base, remote, processId, uid);
    } catch {
      // A rejected base already removed any partial directory; move on to the next.
    }
  }
  throw new Error('Unable to create a safe SSH ControlPath within 100 bytes');
}

export class SshConnection {
  readonly remote: string;
  readonly controlPath: string;
  private readonly directory: string;
  private readonly spawnProcess: typeof spawn;
  private readonly port: number | undefined;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private spawnedAny = false;

  constructor(
    remote: string,
    controlPath: SshControlPath,
    spawnProcess: typeof spawn,
    port?: number
  ) {
    this.remote = remote;
    this.controlPath = controlPath.socketPath;
    this.directory = controlPath.directory;
    this.spawnProcess = spawnProcess;
    this.port = port;
  }

  spawn(command: string): SshChildProcess {
    if (this.closed) throw new Error('SSH connection is closed');
    const opts = [
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPersist=${CONTROL_PERSIST}`,
      '-o',
      `ControlPath=${this.controlPath}`,
      '-o',
      `ServerAliveInterval=${SERVER_ALIVE_INTERVAL}`,
      '-o',
      `ServerAliveCountMax=${SERVER_ALIVE_COUNT_MAX}`,
      '-o',
      `ConnectTimeout=${CONNECT_TIMEOUT}`,
      '-o',
      `ConnectionAttempts=${CONNECTION_ATTEMPTS}`,
    ];
    const portOpts = this.port !== undefined ? ['-p', String(this.port)] : [];
    const child = this.spawnSsh([...opts, ...portOpts, this.remote, command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.spawnedAny = true;
    return child;
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      this.closePromise = this.performClose();
    }
    return this.closePromise;
  }

  private spawnSsh(args: string[], options: { stdio: StdioOptions }): SshChildProcess {
    return this.spawnProcess('ssh', args, options) as SshChildProcess;
  }

  private async performClose(): Promise<void> {
    try {
      if (this.spawnedAny) {
        await new Promise<void>((resolve) => {
          let child: SshChildProcess;
          try {
            child = this.spawnSsh(
              ['-o', `ControlPath=${this.controlPath}`, '-O', 'exit', this.remote],
              { stdio: 'ignore' }
            );
          } catch {
            resolve();
            return;
          }
          let settled = false;
          const once = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          child.on('error', once);
          child.on('close', once);
        });
      }
    } finally {
      // Best-effort: a failed local removal must not reject session shutdown.
      await rm(this.directory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function createSshConnection(
  remote: string,
  dependencies: SshRuntimeDependencies = {},
  port?: number
): Promise<SshConnection> {
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  // Key the control path on remote+port so same-host/different-port targets get distinct sockets.
  const controlRemote = port !== undefined ? `${remote}#${port}` : remote;
  const controlPath = await createSshControlPath(controlRemote, dependencies);
  return new SshConnection(remote, controlPath, spawnProcess, port);
}

async function createPrivateControlPath(
  base: string,
  remote: string,
  processId: number,
  uid: number | undefined
): Promise<SshControlPath> {
  const directory = await mkdtemp(path.join(base, `${PRIVATE_DIR_PREFIX}${processId}-`));
  try {
    await chmod(directory, 0o700);
    if (uid !== undefined) {
      const directoryStats = await stat(directory);
      if (directoryStats.uid !== uid) {
        throw new Error('private control path directory has an unexpected owner');
      }
    }
    const basename = createHash('sha256').update(remote).digest('hex').slice(0, TARGET_HASH_LENGTH);
    const socketPath = path.join(directory, basename);
    if (Buffer.byteLength(socketPath, 'utf8') > CONTROL_PATH_MAX_BYTES) {
      throw new Error('socket path exceeds the OpenSSH byte limit');
    }
    return { directory, socketPath };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
