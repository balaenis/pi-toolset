// ABOUTME: Verifies the SSH connection module: safe control paths, multiplexed spawning, reuse, and cleanup.
// ABOUTME: Uses injected process and env dependencies; no live SSH in unit tests.
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { spawn, type StdioOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CONTROL_PERSIST,
  createSshConnection,
  createSshControlPath,
  type SshRuntimeDependencies,
} from '../src/ssh.ts';
import { FakeChild } from './helpers/fake-child.ts';

function makeSpawnRecorder() {
  const calls: { command: string; args: string[]; stdio: unknown; detached?: boolean }[] = [];
  const children: FakeChild[] = [];
  const spawnProcess = mock(
    (command: string, args: string[], options: { stdio: unknown; detached?: boolean }) => {
      calls.push({
        command,
        args,
        stdio: options.stdio,
        detached: options.detached,
      });
      const child = new FakeChild();
      children.push(child);
      return child;
    }
  ) as unknown as typeof spawn;
  return { calls, children, spawnProcess };
}

const testRoots: string[] = [];

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-test-'));
  testRoots.push(root);
  return root;
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    env: {},
    processId: 4242,
    getUid: () => process.getuid?.(),
    temporaryDirectory: '',
    ...overrides,
  };
}

afterEach(async () => {
  for (const root of testRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('createSshControlPath', () => {
  it('creates a private control path within the OpenSSH socket limit', async () => {
    const tempRoot = await freshRoot();
    const deps = makeDeps({ temporaryDirectory: tempRoot });

    const firstSameDestinationPath = await createSshControlPath('user@example.com', deps);
    const secondSameDestinationPath = await createSshControlPath('user@example.com', deps);
    const differentDestinationPath = await createSshControlPath('admin@otherhost', deps);

    const parentMode = (await stat(path.dirname(firstSameDestinationPath.socketPath))).mode & 0o777;
    expect(parentMode).toBe(0o700);
    expect(Buffer.byteLength(firstSameDestinationPath.socketPath, 'utf8')).toBeLessThanOrEqual(100);

    const basename = path.basename(firstSameDestinationPath.socketPath);
    expect(basename).not.toContain('user');
    expect(basename).not.toContain('example.com');

    expect(secondSameDestinationPath.socketPath).not.toBe(firstSameDestinationPath.socketPath);
    expect(path.basename(secondSameDestinationPath.socketPath)).toBe(basename);
    expect(path.basename(differentDestinationPath.socketPath)).not.toBe(basename);

    expect(firstSameDestinationPath.socketPath.startsWith(tempRoot)).toBe(true);
    expect(secondSameDestinationPath.socketPath.startsWith(tempRoot)).toBe(true);
  });

  async function assertNoLeakedDirs(root: string) {
    const entries = await readdir(root);
    expect(entries.filter((e) => e.startsWith('pi-r-'))).toEqual([]);
  }

  it('falls back to the temporary directory when XDG_RUNTIME_DIR is unsafe', async () => {
    const fallbackRoot = await freshRoot();
    const unsafeRoot = await freshRoot();
    const unsafeXdg = path.join(unsafeRoot, 'unsafe-xdg');
    await mkdir(unsafeXdg, { mode: 0o777 });
    // Re-assert 0777 so the process umask cannot silently make it safe.
    await chmod(unsafeXdg, 0o777);
    expect((await stat(unsafeXdg)).mode & 0o022).not.toBe(0);
    const deps = makeDeps({
      env: { XDG_RUNTIME_DIR: unsafeXdg },
      temporaryDirectory: fallbackRoot,
    });

    const result = await createSshControlPath('user@host', deps);

    const fromFallback = path.relative(fallbackRoot, result.socketPath);
    expect(fromFallback && !fromFallback.startsWith('..')).toBe(true);
    expect(path.relative(unsafeXdg, result.socketPath).startsWith('..')).toBe(true);
    expect((await stat(path.dirname(result.socketPath))).mode & 0o777).toBe(0o700);
  });

  it('removes an overlong XDG candidate before using the next base', async () => {
    const tempRoot = await freshRoot();
    const longName = 'd'.repeat(80);
    const longXdg = path.join(tempRoot, longName);
    await mkdir(longXdg, { mode: 0o700 });
    const deps = makeDeps({
      env: { XDG_RUNTIME_DIR: longXdg },
      temporaryDirectory: tempRoot,
    });

    const result = await createSshControlPath('user@host', deps);

    expect(result.socketPath.startsWith(tempRoot)).toBe(true);
    expect(result.socketPath.startsWith(longXdg)).toBe(false);
    await assertNoLeakedDirs(longXdg);
  });

  it('removes all rejected candidates when no control path fits', async () => {
    const tempRoot = await freshRoot();
    const longName = 'd'.repeat(80);
    const longXdg = path.join(tempRoot, longName);
    await mkdir(longXdg, { mode: 0o700 });
    const longTemp = path.join(tempRoot, 'n'.repeat(80));
    await mkdir(longTemp, { mode: 0o700 });
    const deps = makeDeps({
      env: { XDG_RUNTIME_DIR: longXdg },
      temporaryDirectory: longTemp,
    });

    await expect(createSshControlPath('user@host', deps)).rejects.toThrow(
      'Unable to create a safe SSH ControlPath within 100 bytes'
    );
    await assertNoLeakedDirs(longXdg);
    await assertNoLeakedDirs(longTemp);
  });

  it('rejects an XDG runtime dir owned by a different user by default', async () => {
    const tempRoot = await freshRoot();
    const xdg = path.join(tempRoot, 'xdg');
    await mkdir(xdg, { mode: 0o700 });
    const realUid = process.getuid?.();
    const spy = spyOn(process, 'getuid').mockReturnValue((realUid ?? 0) + 1);
    try {
      const deps = makeDeps({
        env: { XDG_RUNTIME_DIR: xdg },
        temporaryDirectory: '',
        getUid: undefined,
      });

      await expect(createSshControlPath('user@host', deps)).rejects.toThrow(
        'Unable to create a safe SSH ControlPath within 100 bytes'
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects XDG runtime dir when the current UID is unavailable', async () => {
    const tempRoot = await freshRoot();
    const xdg = path.join(tempRoot, 'xdg');
    await mkdir(xdg, { mode: 0o700 });
    const deps = makeDeps({
      env: { XDG_RUNTIME_DIR: xdg },
      getUid: () => undefined,
      temporaryDirectory: '',
    });

    await expect(createSshControlPath('user@host', deps)).rejects.toThrow(
      'Unable to create a safe SSH ControlPath within 100 bytes'
    );
    await assertNoLeakedDirs(xdg);
  });

  it('removes a private candidate with an unexpected owner', async () => {
    const tempRoot = await freshRoot();
    const realUid = process.getuid?.();
    const deps = makeDeps({
      temporaryDirectory: tempRoot,
      getUid: () => (realUid ?? 0) + 1,
    });

    await expect(createSshControlPath('user@host', deps)).rejects.toThrow(
      'Unable to create a safe SSH ControlPath within 100 bytes'
    );
    await assertNoLeakedDirs(tempRoot);
  });
});

describe('createSshConnection', () => {
  it('adds bounded liveness options, never replays a failed child, and reuses one control path', async () => {
    const tempRoot = await freshRoot();
    const { calls, children, spawnProcess } = makeSpawnRecorder();
    const deps = makeDeps({ temporaryDirectory: tempRoot, spawnProcess });

    const conn = await createSshConnection('user@host', deps);
    expect(calls).toHaveLength(0);

    conn.spawn('echo hi');
    children[0]!.emit('close', 255);

    expect(calls).toHaveLength(1);

    conn.spawn('ls -la');

    expect(calls).toHaveLength(2);
    const [first, second] = calls;
    const expectedArgs = (command: string) => [
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPersist=${CONTROL_PERSIST}`,
      '-o',
      `ControlPath=${conn.controlPath}`,
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'ConnectTimeout=15',
      '-o',
      'ConnectionAttempts=2',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      'user@host',
      command,
    ];
    expect(first!.args).toEqual(expectedArgs('echo hi'));
    expect(second!.args).toEqual(expectedArgs('ls -la'));
    expect(first!.args[5]).toBe(second!.args[5]);
    expect(first!.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(first!.detached).toBe(true);
  });

  it('emits -p PORT and keys the control path by host+port', async () => {
    const tempRoot = await freshRoot();
    const { calls, children, spawnProcess } = makeSpawnRecorder();
    const deps = makeDeps({ temporaryDirectory: tempRoot, spawnProcess });

    const conn = await createSshConnection('user@host', deps, 2222);
    conn.spawn('echo hi');
    children[0]!.emit('close', 0);

    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    expect(args).toContain('-p');
    expect(args[args.indexOf('-p') + 1]).toBe('2222');
    expect(args).toContain('user@host');

    const noPort = await createSshConnection('user@host', deps);
    expect(noPort.controlPath).not.toBe(conn.controlPath);
  });

  it('closes the master and cleans resources once', async () => {
    const tempRoot = await freshRoot();
    const { calls, children, spawnProcess } = makeSpawnRecorder();
    const deps = makeDeps({ temporaryDirectory: tempRoot, spawnProcess });
    const conn = await createSshConnection('user@host', deps);

    conn.spawn('echo hi');
    const firstClosePromise = conn.close();
    const secondClosePromise = conn.close();
    const cleanupChild = children[1]!;
    cleanupChild.emit('close', 1);

    await Promise.all([firstClosePromise, secondClosePromise]);

    const cleanupCalls = calls.slice(1);
    expect(cleanupCalls).toHaveLength(1);
    expect(cleanupCalls[0]!.args).toEqual([
      '-o',
      `ControlPath=${conn.controlPath}`,
      '-O',
      'exit',
      'user@host',
    ]);
    expect(cleanupCalls[0]!.stdio).toBe('ignore');
    expect(cleanupCalls[0]!.detached).toBeUndefined();

    expect(existsSync(path.dirname(conn.controlPath))).toBe(false);
    expect(() => conn.spawn('x')).toThrow('SSH connection is closed');
  });

  it('swallows a synchronous cleanup spawn failure and still removes the directory', async () => {
    const tempRoot = await freshRoot();
    const { spawnProcess } = makeSpawnRecorder();
    const failingSpawn = mock(
      (command: string, args: string[], options: { stdio: StdioOptions }) => {
        if (args.includes('-O')) throw new Error('spawn failed');
        return spawnProcess(command, args, options);
      }
    ) as unknown as typeof spawn;
    const deps = makeDeps({ temporaryDirectory: tempRoot, spawnProcess: failingSpawn });

    const conn = await createSshConnection('user@host', deps);
    conn.spawn('echo hi');

    await conn.close();

    expect(existsSync(path.dirname(conn.controlPath))).toBe(false);
    await conn.close();
  });

  it('skips master exit when command spawning throws synchronously', async () => {
    const tempRoot = await freshRoot();
    const calls: { command: string; args: string[] }[] = [];
    const failingSpawn = mock(
      (command: string, args: string[], _options: { stdio: StdioOptions }) => {
        calls.push({ command, args });
        throw new Error('spawn failed');
      }
    ) as unknown as typeof spawn;
    const deps = makeDeps({ temporaryDirectory: tempRoot, spawnProcess: failingSpawn });

    const conn = await createSshConnection('user@host', deps);
    expect(() => conn.spawn('echo hi')).toThrow('spawn failed');

    await conn.close();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).not.toContain('-O');
    expect(existsSync(path.dirname(conn.controlPath))).toBe(false);
  });

  it('declares the injected spawn dependency as the exact Node spawn type', () => {
    type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
    const check: AssertEqual<
      NonNullable<SshRuntimeDependencies['spawnProcess']>,
      typeof spawn
    > = true;
    expect(check).toBe(true);
  });

  it('does not expose a filesystem-removal injection seam', () => {
    type HasRemoveDirectory = 'removeDirectory' extends keyof SshRuntimeDependencies ? true : false;
    const check: HasRemoveDirectory = false;
    expect(check).toBe(false);
  });
});
