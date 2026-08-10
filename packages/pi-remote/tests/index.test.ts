// ABOUTME: Verifies pi-remote lifecycle wiring: session-scoped SSH connection ownership, lazy pathless startup, shutdown.
// ABOUTME: Lifecycle tests inject a fake connection factory; the default-export test uses the real factory without live SSH.
import { describe, expect, it, mock } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem, AutocompleteProvider } from '@earendil-works/pi-tui';
import { chmod, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  default as registerPiRemoteDefault,
  registerPiRemote,
  type PiRemoteDependencies,
} from '../src/index.ts';
import type { SshChildProcess } from '../src/ssh.ts';
import { FakeChild } from './helpers/fake-child.ts';

const SSH_FAILURE_EXIT_CODE = 255;
const CWD_CANDIDATE_CAP = 100;
const GENERATED_CANDIDATE_COUNT = 120;
const CANDIDATE_PAD_WIDTH = 3;
const LAST_CANDIDATE_INDEX = CWD_CANDIDATE_CAP - 1;
const SPAWN_POLL_INTERVAL_MS = 1;

// Hand-verified shell-quoted form of the hostile cwd fixture used below
// ("/remote/proj $(touch /tmp/pwned) `id` $HOME; echo 'hi'"). Independent literal:
// a regression in the production quoting algorithm must break these expectations.
const QUOTED_HOSTILE_CWD = "'/remote/proj $(touch /tmp/pwned) `id` $HOME; echo '\"'\"'hi'\"'\"''";

// Hostile cwd fixture shared by the quoting scenarios. Input data only: expected
// commands keep using the independent hand-verified QUOTED_HOSTILE_CWD literal.
const HOSTILE_CWD = "/remote/proj $(touch /tmp/pwned) `id` $HOME; echo 'hi'";

type RegisteredBashTool = {
  execute: (
    id: string,
    params: { command: string },
    signal: unknown,
    onUpdate: unknown
  ) => Promise<unknown>;
};

function makeAutocompleteProviderStub(): AutocompleteProvider {
  return {
    getSuggestions: async () => null,
    applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
    shouldTriggerFileCompletion: () => false,
  };
}

// Waits until the fake connection has spawned the indexed child and returns its command.
async function untilSpawn(conn: FakeSshConnection, index: number): Promise<string> {
  while (conn.spawnCalls.length <= index) {
    await new Promise((resolve) => setTimeout(resolve, SPAWN_POLL_INTERVAL_MS));
  }
  return conn.spawnCalls[index]!.command;
}

class FakeSshConnection {
  readonly remote: string;
  readonly controlPath: string;
  spawnCalls: { command: string }[] = [];
  children: FakeChild[] = [];
  closeCalls = 0;
  private closeError: Error | null = null;
  private deferredClose = false;
  private finish: (() => void) | null = null;
  constructor(remote: string) {
    this.remote = remote;
    this.controlPath = `/tmp/pi-test-conn-${encodeURIComponent(remote)}`;
  }
  spawn(command: string) {
    this.spawnCalls.push({ command });
    const child = new FakeChild();
    this.children.push(child);
    return child as unknown as SshChildProcess;
  }
  failClose(error: Error) {
    this.closeError = error;
  }
  deferClose() {
    this.deferredClose = true;
  }
  finishClose() {
    this.finish?.();
    this.finish = null;
  }
  close() {
    this.closeCalls++;
    if (this.deferredClose) {
      return new Promise<void>((resolve) => {
        this.finish = resolve;
      });
    }
    return this.closeError ? Promise.reject(this.closeError) : Promise.resolve();
  }
}

function makePi(flags: Record<string, string | boolean> = {}) {
  const handlers: Record<string, ((...args: unknown[]) => unknown)[]> = {};
  const tools: unknown[] = [];
  const commands: unknown[] = [];
  const ui = {
    notifications: [] as { message: string; kind: string }[],
    statuses: [] as { key: string; text: string }[],
    providers: [] as unknown[],
    selectCalls: [] as { title: string; items: string[] }[],
    selectResult: undefined as string | undefined,
    theme: { fg: (_kind: string, text: string) => text },
    notify: (message: string, kind: string) => {
      ui.notifications.push({ message, kind });
    },
    setStatus: (key: string, text: string) => {
      ui.statuses.push({ key, text });
    },
    addAutocompleteProvider: (factory: unknown) => {
      ui.providers.push(factory);
    },
    select: mock(async (title: string, items: string[]) => {
      ui.selectCalls.push({ title, items });
      return ui.selectResult;
    }),
  };
  const pi = {
    registerFlag: mock((_name: string, _options: unknown) => {}),
    getFlag: mock((name: string) => flags[name]),
    registerTool: mock((tool: unknown) => {
      tools.push(tool);
    }),
    registerCommand: mock((name: string, options: unknown) => {
      commands.push({ name, ...(options as object) });
    }),
    on: mock((event: string, handler: (...args: unknown[]) => unknown) => {
      (handlers[event] ??= []).push(handler);
    }),
  };
  return { pi, handlers, ui, tools, commands, ctx: { ui } };
}

function makeHarness(flag: string) {
  const { pi, handlers, ui, tools, commands, ctx } = makePi({ ssh: flag });
  const connections: FakeSshConnection[] = [];
  const connectionArgs: { remote: string; port: number | undefined }[] = [];
  const createSshConnection = mock((remote: string, _deps?: unknown, port?: number) => {
    connectionArgs.push({ remote, port });
    const conn = new FakeSshConnection(remote);
    connections.push(conn);
    return Promise.resolve(conn);
  }) as unknown as PiRemoteDependencies['createSshConnection'];
  const getTool = (name: string) => {
    const tool = tools.find((t) => (t as { name?: string }).name === name);
    if (!tool) throw new Error(`registered tool not found: ${name}`);
    return tool;
  };
  registerPiRemote(pi as unknown as ExtensionAPI, { createSshConnection });
  return {
    pi,
    handlers,
    ui,
    tools,
    commands,
    ctx,
    connections,
    connectionArgs,
    createSshConnection,
    getTool,
  };
}

describe('registerPiRemote session lifecycle', () => {
  it('defers SSH setup to the session lifecycle', async () => {
    const { handlers, ui, ctx, connections, createSshConnection } =
      makeHarness('user@host:/remote/path');

    expect(createSshConnection).not.toHaveBeenCalled();
    expect(connections).toHaveLength(0);

    const startHandler = handlers.session_start![0]!;
    await startHandler({}, ctx);

    expect(connections).toHaveLength(1);
    const conn = connections[0]!;
    expect(conn.remote).toBe('user@host');
    expect(conn.spawnCalls).toHaveLength(0);
    expect(ui.providers).toHaveLength(1);
    const status = ui.statuses.find((s) => s.key === 'ssh')!;
    expect(status.text).toContain('user@host');
    expect(status.text).toContain('/remote/path');

    const bashResult = handlers.user_bash![0]!({}, ctx) as {
      operations: {
        exec: (
          command: string,
          cwd: string,
          options: { onData: (d: Buffer) => void }
        ) => Promise<{ exitCode: number | null }>;
      };
    };
    const data: Buffer[] = [];
    const execPromise = bashResult.operations.exec('echo hi', process.cwd(), {
      onData: (d) => data.push(d),
    });
    conn.children[0]!.stdout.write('hello');
    conn.children[0]!.emit('close', 0);
    const execResult = await execPromise;

    expect(execResult.exitCode).toBe(0);
    expect(data.map((d) => d.toString()).join('')).toBe('hello');
    expect(conn.spawnCalls[0]!.command).toBe("cd -- '/remote/path' && echo hi");

    const shutdownHandler = handlers.session_shutdown![0]!;
    await shutdownHandler({}, ctx);
    await shutdownHandler({}, ctx);
    expect(conn.closeCalls).toBe(1);

    expect(handlers.user_bash![0]!({}, ctx)).toBeUndefined();
  });

  it('exposes no remote operations while shutdown cleanup is pending', async () => {
    const { handlers, ctx, connections } = makeHarness('user@host:/remote/path');
    const startHandler = handlers.session_start![0]!;
    await startHandler({}, ctx);

    const conn = connections[0]!;
    conn.deferClose();
    const shutdownHandler = handlers.session_shutdown![0]!;
    const shutdown1 = shutdownHandler({}, ctx);
    const shutdown2 = shutdownHandler({}, ctx);
    try {
      expect(handlers.user_bash![0]!({}, ctx)).toBeUndefined();
      expect(conn.closeCalls).toBe(1);
    } finally {
      conn.finishClose();
    }
    await Promise.all([shutdown1, shutdown2]);
    expect(conn.closeCalls).toBe(1);
  });

  it('keeps failed SSH startup loud and closes its connection', async () => {
    await assertFailedPathlessStartup();
  });

  it('reports the original SSH failure when cleanup also fails', async () => {
    await assertFailedPathlessStartup(new Error('cleanup failed'));
  });

  it('default export creates and cleans a real SSH connection', async () => {
    const originalXdg = process.env.XDG_RUNTIME_DIR;
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'pi-default-export-'));
    await chmod(runtimeRoot, 0o700);
    let shutdownHandler: ((...args: unknown[]) => unknown) | null = null;
    try {
      process.env.XDG_RUNTIME_DIR = runtimeRoot;
      const { pi, handlers, ctx } = makePi({ ssh: 'user@host:/remote/path' });
      registerPiRemoteDefault(pi as unknown as ExtensionAPI);

      const startHandler = handlers.session_start![0]!;
      await startHandler({}, ctx);
      shutdownHandler = handlers.session_shutdown![0]!;

      // The real factory creates a private mode-0700 runtime dir before any SSH spawn.
      const entries = await readdir(runtimeRoot);
      const privateDirs = entries.filter((e) => e.startsWith('pi-r-'));
      expect(privateDirs).toHaveLength(1);
      expect((await stat(path.join(runtimeRoot, privateDirs[0]!))).mode & 0o777).toBe(0o700);

      await shutdownHandler({}, ctx);
      expect(await readdir(runtimeRoot)).toEqual([]);
    } finally {
      if (shutdownHandler) {
        try {
          await shutdownHandler({}, {});
        } catch {
          // Cleanup is best-effort on assertion failure.
        }
      }
      if (originalXdg === undefined) {
        delete process.env.XDG_RUNTIME_DIR;
      } else {
        process.env.XDG_RUNTIME_DIR = originalXdg;
      }
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });
});

interface SshCommand {
  name?: string;
  description?: string;
  getArgumentCompletions?: (
    prefix: string
  ) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

type BashOps = {
  operations: {
    exec: (
      command: string,
      cwd: string,
      options: { onData: (d: Buffer) => void }
    ) => Promise<{ exitCode: number | null }>;
  };
};

function getRegisteredCommand(commands: unknown[], name: string): SshCommand {
  const command = commands.find((c) => (c as SshCommand).name === name) as SshCommand | undefined;
  if (!command) throw new Error(`registered command not found: ${name}`);
  return command;
}

describe('registerPiRemote /ssh:cwd command', () => {
  it('registers ssh:cwd and rejects use without an SSH connection', async () => {
    const { commands, ctx, connections, ui } = makeHarness('');
    const command = getRegisteredCommand(commands, 'ssh:cwd');

    expect(command).toBeDefined();
    expect(command.description).toContain('remote working directory');

    expect(await command.getArgumentCompletions?.('abc')).toBeNull();
    expect(connections).toHaveLength(0);

    await command.handler('abc', ctx);
    expect(connections).toHaveLength(0);
    expect(ui.notifications).toEqual([
      { message: 'No active SSH connection. Use /ssh first.', kind: 'error' },
    ]);
  });

  it('offers fuzzy fd directory completions under the current remote cwd', async () => {
    const { commands, ctx, connections, handlers } = makeHarness('user@host:/remote/project');
    await handlers.session_start![0]!({}, ctx);
    const conn = connections[0]!;
    const command = getRegisteredCommand(commands, 'ssh:cwd');

    const completionPromise = command.getArgumentCompletions!('AbC');
    expect(conn.spawnCalls).toHaveLength(1);
    const cmd = conn.spawnCalls[0]!.command;
    expect(cmd.startsWith('bash -c ')).toBe(true);
    expect(cmd).toContain('cd -- "$1"');
    expect(cmd.endsWith(`-- '/remote/project' 'a.*b.*c'`)).toBe(true);
    expect(cmd).toContain(
      "fd --type d --max-results 100 --follow --hidden --color=never --exclude .git --exclude '\"'\"'.git/*'\"'\"' --exclude '\"'\"'.git/**'\"'\"'"
    );

    const listChild = conn.children[0]!;
    listChild.stdout.write(
      './src/AbC\nAbC-app\ndocs/AbC Docs\nmyabc-app/\nabc-proj/notes\nabxcy\nzzz\nsrc/.git/config\n./\n'
    );
    listChild.emit('close', 0);
    const items = await completionPromise;

    expect(items).toEqual([
      { value: '..', label: '..' },
      { value: 'src/AbC', label: 'AbC', description: 'src/AbC' },
      { value: 'AbC-app', label: 'AbC-app' },
      { value: 'docs/AbC Docs', label: 'AbC Docs', description: 'docs/AbC Docs' },
      { value: 'myabc-app', label: 'myabc-app' },
      { value: 'abc-proj/notes', label: 'notes', description: 'abc-proj/notes' },
      { value: 'abxcy', label: 'abxcy' },
    ]);

    const cappedPromise = command.getArgumentCompletions!('AbC');
    const capChild = conn.children[1]!;
    const capLines = Array.from(
      { length: GENERATED_CANDIDATE_COUNT },
      (_, i) => `abc-${String(i).padStart(CANDIDATE_PAD_WIDTH, '0')}`
    ).join('\n');
    capChild.stdout.write(`${capLines}\n`);
    capChild.emit('close', 0);
    const capped = await cappedPromise;

    expect(capped).toHaveLength(CWD_CANDIDATE_CAP);
    expect(capped![0]).toEqual({ value: '..', label: '..' });
    expect(capped![LAST_CANDIDATE_INDEX]).toEqual({ value: 'abc-098', label: 'abc-098' });
  });

  it('applies the typed query before the remote fd result cap', async () => {
    const { commands, ctx, connections, handlers } = makeHarness('hasee-arch:/home/admin');
    await handlers.session_start![0]!({}, ctx);
    const conn = connections[0]!;
    const command = getRegisteredCommand(commands, 'ssh:cwd');

    const completionPromise = command.getArgumentCompletions!('Work');
    const cmd = conn.spawnCalls[0]!.command;
    expect(cmd).toContain('fd --type d');
    expect(cmd).toContain('--ignore-case --full-path -- "$2"');
    expect(cmd).toEndWith("-- '/home/admin' 'w.*o.*r.*k'");

    const remoteDirectories = [
      ...Array.from({ length: CWD_CANDIDATE_CAP }, (_, index) => `.claude/noise-${index}`),
      'Workspace',
    ];
    const fdResultsBeforeCap = remoteDirectories
      .filter((directory) => /w.*o.*r.*k/i.test(directory))
      .slice(0, CWD_CANDIDATE_CAP);
    expect(fdResultsBeforeCap).toEqual(['Workspace']);
    conn.children[0]!.stdout.write(`${fdResultsBeforeCap.join('\n')}\n`);
    conn.children[0]!.emit('close', 0);

    expect(await completionPromise).toEqual([
      { value: '..', label: '..' },
      { value: 'Workspace', label: 'Workspace' },
    ]);
  });

  it('passes the listing cwd as a quoted Bash positional argument', async () => {
    const { commands, ctx, connections, handlers } = makeHarness(`user@host:${HOSTILE_CWD}`);
    await handlers.session_start![0]!({}, ctx);
    const conn = connections[0]!;
    const command = getRegisteredCommand(commands, 'ssh:cwd');

    const completionPromise = command.getArgumentCompletions!('');
    expect(conn.spawnCalls).toHaveLength(1);
    const cmd = conn.spawnCalls[0]!.command;
    expect(cmd.startsWith('bash -c ')).toBe(true);
    expect(cmd.endsWith(`-- ${QUOTED_HOSTILE_CWD} ''`)).toBe(true);
    expect(cmd).toContain('cd -- "$1"');
    const scriptBody = cmd.slice(0, cmd.indexOf("' -- '"));
    expect(scriptBody).not.toContain('$(touch');
    expect(scriptBody).not.toContain('`id`');
    expect(scriptBody).not.toContain('$HOME');
    expect(scriptBody).not.toContain('; echo');

    const listChild = conn.children[0]!;
    listChild.stdout.write('src\n');
    listChild.emit('close', 0);
    const items = await completionPromise;

    expect(items).toEqual([
      { value: '..', label: '..' },
      { value: 'src', label: 'src' },
    ]);
  });

  it('quotes fd git exclude patterns as shell literals in the remote listing command', async () => {
    const { commands, ctx, connections, handlers } = makeHarness('user@host:/remote/project');
    await handlers.session_start![0]!({}, ctx);
    const conn = connections[0]!;
    const command = getRegisteredCommand(commands, 'ssh:cwd');

    const completionPromise = command.getArgumentCompletions!('');
    expect(conn.spawnCalls).toHaveLength(1);
    const cmd = conn.spawnCalls[0]!.command;
    expect(cmd).toContain("--exclude '\"'\"'.git/*'\"'\"'");
    expect(cmd).toContain("--exclude '\"'\"'.git/**'\"'\"'");
    expect(cmd).toEndWith("-- '/remote/project' ''");

    const listChild = conn.children[0]!;
    listChild.stdout.write('src\n');
    listChild.emit('close', 0);
    const items = await completionPromise;

    expect(items).toEqual([
      { value: '..', label: '..' },
      { value: 'src', label: 'src' },
    ]);
  });

  it('falls back to find when fd is unavailable', async () => {
    const { commands, ctx, connections, handlers } = makeHarness('user@host:/remote/project');
    await handlers.session_start![0]!({}, ctx);
    const conn = connections[0]!;
    const command = getRegisteredCommand(commands, 'ssh:cwd');

    const completionPromise = command.getArgumentCompletions!('AbC');
    const cmd = conn.spawnCalls[0]!.command;
    expect(cmd).toContain('command -v fd >/dev/null 2>&1');
    expect(cmd).toContain('find -L . -mindepth 1');
    expect(cmd).toContain('awk -v pattern="$2"');
    expect(cmd).toEndWith("-- '/remote/project' 'a.*b.*c'");

    const listChild = conn.children[0]!;
    listChild.stdout.write('./src/AbC\n./abxcy\n./zzz\n');
    listChild.emit('close', 0);
    const items = await completionPromise;

    expect(items).toEqual([
      { value: '..', label: '..' },
      { value: 'src/AbC', label: 'AbC', description: 'src/AbC' },
      { value: 'abxcy', label: 'abxcy' },
    ]);

    const failPromise = command.getArgumentCompletions!('x');
    const failChild = conn.children[1]!;
    failChild.stderr.write('connection lost');
    failChild.emit('close', SSH_FAILURE_EXIT_CODE);
    expect(await failPromise).toBeNull();

    const partialPromise = command.getArgumentCompletions!('x');
    const partialChild = conn.children[2]!;
    partialChild.stdout.write('./partial-result\n');
    partialChild.stderr.write('connection lost after output');
    partialChild.emit('close', SSH_FAILURE_EXIT_CODE);
    expect(await partialPromise).toBeNull();
  });

  it('switches shared remote cwd after an explicit relative path succeeds', async () => {
    const { commands, ctx, connections, getTool, handlers, ui } = makeHarness(
      'user@host:/remote/project'
    );
    await handlers.session_start![0]!({}, ctx);
    const conn = connections[0]!;
    const command = getRegisteredCommand(commands, 'ssh:cwd');

    const oldBash = handlers.user_bash![0]!({}, ctx) as BashOps;
    const oldBashPromise = oldBash.operations.exec('echo old', process.cwd(), {
      onData: () => {},
    });
    expect(conn.spawnCalls[0]!.command).toBe("cd -- '/remote/project' && echo old");

    const handlerPromise = command.handler('packages/app one', ctx);
    const resolverCmd = conn.spawnCalls[1]!.command;
    expect(resolverCmd.startsWith('bash -c ')).toBe(true);
    expect(resolverCmd.endsWith(`-- '/remote/project' 'packages/app one'`)).toBe(true);
    expect(resolverCmd).toContain('cd -- "$1" && cd -- "$target" && pwd');
    const resolverChild = conn.children[1]!;
    resolverChild.stdout.write('/remote/project/packages/app one\n');
    resolverChild.emit('close', 0);
    await handlerPromise;

    conn.children[0]!.emit('close', 0);
    await oldBashPromise;

    const newBash = handlers.user_bash![0]!({}, ctx) as BashOps;
    const newBashPromise = newBash.operations.exec('echo new', process.cwd(), {
      onData: () => {},
    });
    expect(conn.spawnCalls[2]!.command).toBe(
      "cd -- '/remote/project/packages/app one' && echo new"
    );
    conn.children[2]!.emit('close', 0);
    await newBashPromise;

    const bashTool = getTool('bash') as RegisteredBashTool;
    const toolPromise = bashTool.execute(
      'cwd-switch-tool',
      { command: 'echo tool' },
      undefined,
      undefined
    );
    expect(conn.spawnCalls[3]!.command).toBe(
      "cd -- '/remote/project/packages/app one' && echo tool"
    );
    conn.children[3]!.emit('close', 0);
    await toolPromise;

    const promptResult = (await handlers.before_agent_start![0]!(
      { systemPrompt: 'base' },
      ctx
    )) as { systemPrompt: string };
    expect(promptResult.systemPrompt).toContain('/remote/project/packages/app one');

    const currentProvider = makeAutocompleteProviderStub();
    const provider = (ui.providers[0] as (current: AutocompleteProvider) => AutocompleteProvider)(
      currentProvider
    );
    const suggestionsPromise = provider.getSuggestions(['@'], 0, 1, {
      signal: new AbortController().signal,
    });
    const autocompleteCmd = conn.spawnCalls[4]!.command;
    // The whole listing script is one quoted bash -c argument, so each inner argument's
    // quotes are escaped once more. Hand-verified double-escaped literal.
    const baseDir = "'\"'\"'--base-directory'\"'\"' '\"'\"'/remote/project/packages/app one'\"'\"'";
    expect(autocompleteCmd.split(baseDir).length - 1).toBe(2);
    conn.children[4]!.stdout.write('1 src\n');
    conn.children[4]!.emit('close', 0);
    const suggestions = await suggestionsPromise;
    expect(suggestions?.items).toEqual([{ value: '@src/', label: 'src/', description: 'src' }]);

    const latestStatus = ui.statuses.filter((s) => s.key === 'ssh').at(-1)!;
    expect(latestStatus.text).toContain('user@host');
    expect(latestStatus.text).toContain('/remote/project/packages/app one');
    expect(ui.notifications.filter((n) => n.kind === 'info')).toEqual([
      { message: 'Remote working directory: /remote/project/packages/app one', kind: 'info' },
    ]);
  });

  it('resolves supported cwd arguments without shell interpolation', async () => {
    const { commands, ctx, connections, handlers, ui } = makeHarness('user@host:/remote/project');
    await handlers.session_start![0]!({}, ctx);
    const conn = connections[0]!;
    const command = getRegisteredCommand(commands, 'ssh:cwd');

    const hostileTarget = "packages; echo `id` $(whoami) $HOME 'x'";
    const cases = [
      {
        target: '/srv/app',
        resolved: '/srv/app',
        expectedCommandSuffix: "-- '/remote/project' '/srv/app'",
      },
      { target: '~', resolved: '/home/user', expectedCommandSuffix: "-- '/srv/app' '~'" },
      {
        target: '~/src/app',
        resolved: '/home/user/src/app',
        expectedCommandSuffix: "-- '/home/user' '~/src/app'",
      },
      {
        target: hostileTarget,
        resolved: `/home/user/src/app/${hostileTarget}`,
        expectedCommandSuffix:
          "-- '/home/user/src/app' 'packages; echo `id` $(whoami) $HOME '\"'\"'x'\"'\"''",
      },
    ];
    for (const [index, cwdCase] of cases.entries()) {
      const handlerPromise = command.handler(cwdCase.target, ctx);
      const cmd = conn.spawnCalls[index]!.command;
      expect(cmd.startsWith('bash -c ')).toBe(true);
      expect(cmd.endsWith(cwdCase.expectedCommandSuffix)).toBe(true);
      const scriptBody = cmd.slice(cmd.indexOf("'") + 1, cmd.indexOf("' -- '"));
      expect(scriptBody).toContain('case "$2" in');
      expect(scriptBody).toContain('"~") target=$HOME');
      expect(scriptBody).toContain('"~/"*) target=$HOME/${2#\\~/}');
      expect(scriptBody).toContain('*) target=$2');
      expect(scriptBody).toContain('cd -- "$1"');
      expect(scriptBody).toContain('cd -- "$target" && pwd');
      expect(scriptBody).not.toContain('eval');
      if (cwdCase.target === hostileTarget) {
        expect(scriptBody).not.toContain('$(whoami)');
        expect(scriptBody).not.toContain('`id`');
        expect(scriptBody).not.toContain("; echo '");
      }
      const child = conn.children[index]!;
      child.stdout.write(`${cwdCase.resolved}
`);
      child.emit('close', 0);
      await handlerPromise;
    }

    const latestStatus = ui.statuses.filter((s) => s.key === 'ssh').at(-1)!;
    expect(latestStatus.text).toContain(`/home/user/src/app/${hostileTarget}`);
    expect(ui.notifications.filter((n) => n.kind === 'info')).toHaveLength(cases.length);

    const failPromise = command.handler('/nope', ctx);
    const failChild = conn.children[cases.length]!;
    failChild.stderr.write('No such file or directory');
    failChild.emit('close', 1);
    await failPromise;

    expect(ui.notifications.filter((n) => n.kind === 'error')).toEqual([
      { message: 'Cannot change remote cwd: No such file or directory', kind: 'error' },
    ]);
    expect(ui.notifications.filter((n) => n.kind === 'info')).toHaveLength(cases.length);

    const bash = handlers.user_bash![0]!({}, ctx) as BashOps;
    const execPromise = bash.operations.exec('echo after', process.cwd(), { onData: () => {} });
    expect(conn.spawnCalls[cases.length + 1]!.command).toBe(
      "cd -- '/home/user/src/app/packages; echo `id` $(whoami) $HOME '\"'\"'x'\"'\"'' && echo after"
    );
    conn.children[cases.length + 1]!.emit('close', 0);
    await execPromise;
  });

  it('rejects relative resolver output and preserves the remote cwd', async () => {
    const { commands, ctx, connections, handlers, ui } = makeHarness('user@host:/remote/project');
    await handlers.session_start![0]!({}, ctx);
    const conn = connections[0]!;
    const command = getRegisteredCommand(commands, 'ssh:cwd');

    const handlerPromise = command.handler('src', ctx);
    const resolverChild = conn.children[0]!;
    resolverChild.stdout.write('relative/src\n');
    resolverChild.emit('close', 0);
    await handlerPromise;

    const errorNotify = ui.notifications.filter((n) => n.kind === 'error');
    expect(errorNotify).toHaveLength(1);
    expect(errorNotify[0]!.message).toContain('non-absolute');
    expect(ui.notifications.filter((n) => n.kind === 'info')).toHaveLength(0);
    expect(ui.statuses.filter((s) => s.key === 'ssh')).toHaveLength(1);

    const bash = handlers.user_bash![0]!({}, ctx) as BashOps;
    const execPromise = bash.operations.exec('echo after', process.cwd(), { onData: () => {} });
    expect(conn.spawnCalls[1]!.command).toBe("cd -- '/remote/project' && echo after");
    conn.children[1]!.emit('close', 0);
    await execPromise;
  });

  it('opens a cwd picker when no argument is provided', async () => {
    const { commands, ctx, connections, handlers, ui } = makeHarness('user@host:/remote/project');
    await handlers.session_start![0]!({}, ctx);
    const conn = connections[0]!;
    const command = getRegisteredCommand(commands, 'ssh:cwd');
    const flushAsync = () => new Promise<void>((resolve) => setImmediate(resolve));

    ui.selectResult = 'src';
    const pickerPromise = command.handler('', ctx);
    const listChild = conn.children[0]!;
    listChild.stdout.write('src\n');
    listChild.emit('close', 0);
    await flushAsync();

    expect(ui.selectCalls).toEqual([
      { title: 'Select remote directory under /remote/project', items: ['..', 'src'] },
    ]);
    const resolverChild = conn.children[1]!;
    resolverChild.stdout.write('/remote/project/src\n');
    resolverChild.emit('close', 0);
    await pickerPromise;

    const latestStatus = ui.statuses.filter((s) => s.key === 'ssh').at(-1)!;
    expect(latestStatus.text).toContain('/remote/project/src');
    expect(ui.notifications.filter((n) => n.kind === 'info')).toEqual([
      { message: 'Remote working directory: /remote/project/src', kind: 'info' },
    ]);

    ui.selectResult = undefined;
    const cancelPromise = command.handler('', ctx);
    const cancelListChild = conn.children[2]!;
    cancelListChild.stdout.write('src\n');
    cancelListChild.emit('close', 0);
    await cancelPromise;

    expect(conn.children).toHaveLength(3);
    expect(ui.selectCalls).toHaveLength(2);
    expect(ui.selectCalls[1]!.items).toEqual(['..', 'src']);
    expect(ui.statuses.filter((s) => s.key === 'ssh').at(-1)!.text).toContain(
      '/remote/project/src'
    );
    expect(ui.notifications.filter((n) => n.kind === 'info')).toHaveLength(1);
  });

  it('does not apply a cwd resolved after reconnecting', async () => {
    const { commands, ctx, connections, handlers, ui } = makeHarness('');
    const sshCommand = getRegisteredCommand(commands, 'ssh');
    const cwdCommand = getRegisteredCommand(commands, 'ssh:cwd');

    await sshCommand.handler('user@a:/p1', ctx);
    const connA = connections[0]!;
    expect(connA.spawnCalls).toHaveLength(0);

    const switchPromise = cwdCommand.handler('packages/app', ctx);
    expect(connA.spawnCalls).toHaveLength(1);
    const resolverChild = connA.children[0]!;

    await sshCommand.handler('user@b:/p2', ctx);
    const connB = connections[1]!;
    expect(connB.spawnCalls).toHaveLength(0);

    resolverChild.stdout.write('/p1/packages/app\n');
    resolverChild.emit('close', 0);
    await switchPromise;

    expect(connA.closeCalls).toBe(1);
    expect(connB.closeCalls).toBe(0);
    expect(ui.notifications).toContainEqual({
      message: 'Remote working directory switch superseded by a new connection.',
      kind: 'warning',
    });
    expect(ui.notifications.filter((n) => n.kind === 'info')).toHaveLength(0);
    const latestStatus = ui.statuses.filter((s) => s.key === 'ssh').at(-1)!;
    expect(latestStatus.text).toContain('user@b');
    expect(latestStatus.text).toContain('/p2');

    const bash = handlers.user_bash![0]!({}, ctx) as BashOps;
    const execPromise = bash.operations.exec('echo current', process.cwd(), {
      onData: () => {},
    });
    expect(connB.spawnCalls[0]!.command).toBe("cd -- '/p2' && echo current");
    connB.children[0]!.emit('close', 0);
    await execPromise;
  });

  it('reports a rejected cwd resolution as superseded after reconnect', async () => {
    const { commands, ctx, connections, ui } = makeHarness('');
    const sshCommand = getRegisteredCommand(commands, 'ssh');
    const cwdCommand = getRegisteredCommand(commands, 'ssh:cwd');

    await sshCommand.handler('user@a:/p1', ctx);
    const connA = connections[0]!;
    expect(connA.spawnCalls).toHaveLength(0);

    const switchPromise = cwdCommand.handler('packages/app', ctx);
    expect(connA.spawnCalls).toHaveLength(1);
    const resolverChild = connA.children[0]!;

    await sshCommand.handler('user@b:/p2', ctx);
    const connB = connections[1]!;
    expect(connB.spawnCalls).toHaveLength(0);

    resolverChild.stderr.write('No such file or directory');
    resolverChild.emit('close', 1);
    await switchPromise;

    expect(connA.closeCalls).toBe(1);
    expect(connB.closeCalls).toBe(0);
    expect(ui.notifications).toContainEqual({
      message: 'Remote working directory switch superseded by a new connection.',
      kind: 'warning',
    });
    expect(ui.notifications.filter((n) => n.kind === 'error')).toHaveLength(0);
    expect(ui.notifications.some((n) => n.message.includes('Cannot change'))).toBe(false);
    const latestStatus = ui.statuses.filter((s) => s.key === 'ssh').at(-1)!;
    expect(latestStatus.text).toContain('user@b');
    expect(latestStatus.text).toContain('/p2');
  });

  it('keeps cwd usable when the picker listing fails', async () => {
    const { commands, ctx, connections, handlers, ui } = makeHarness('user@host:/remote/project');
    await handlers.session_start![0]!({}, ctx);
    const conn = connections[0]!;
    const command = getRegisteredCommand(commands, 'ssh:cwd');

    const pickerPromise = command.handler('', ctx);
    const listChild = conn.children[0]!;
    listChild.stderr.write('permission denied');
    listChild.emit('close', SSH_FAILURE_EXIT_CODE);
    await pickerPromise;

    expect(ui.selectCalls).toHaveLength(0);
    expect(ui.notifications).toContainEqual({
      message: 'Could not list remote directories: permission denied',
      kind: 'error',
    });
    expect(ui.notifications.filter((n) => n.kind === 'info')).toHaveLength(0);
    expect(ui.statuses.filter((s) => s.key === 'ssh')).toHaveLength(1);

    const beforeBash = handlers.user_bash![0]!({}, ctx) as BashOps;
    const beforePromise = beforeBash.operations.exec('echo before-manual-switch', process.cwd(), {
      onData: () => {},
    });
    expect(conn.spawnCalls[1]!.command).toBe(
      "cd -- '/remote/project' && echo before-manual-switch"
    );
    conn.children[1]!.emit('close', 0);
    await beforePromise;

    const switchPromise = command.handler('src', ctx);
    const resolverChild = conn.children[2]!;
    resolverChild.stdout.write('/remote/project/src\n');
    resolverChild.emit('close', 0);
    await switchPromise;

    expect(ui.notifications).toContainEqual({
      message: 'Remote working directory: /remote/project/src',
      kind: 'info',
    });

    const afterBash = handlers.user_bash![0]!({}, ctx) as BashOps;
    const afterPromise = afterBash.operations.exec('echo after-manual-switch', process.cwd(), {
      onData: () => {},
    });
    expect(conn.spawnCalls[3]!.command).toBe(
      "cd -- '/remote/project/src' && echo after-manual-switch"
    );
    conn.children[3]!.emit('close', 0);
    await afterPromise;
  });

  it('preserves boundary spaces in explicit cwd arguments', async () => {
    const { commands, ctx, connections, handlers, ui } = makeHarness('user@host:/remote/project');
    await handlers.session_start![0]!({}, ctx);
    const conn = connections[0]!;
    const command = getRegisteredCommand(commands, 'ssh:cwd');

    const handlerPromise = command.handler(' target  ', ctx);
    expect(ui.selectCalls).toHaveLength(0);
    const resolverCmd = conn.spawnCalls[0]!.command;
    expect(resolverCmd.startsWith('bash -c ')).toBe(true);
    expect(resolverCmd.endsWith(`-- '/remote/project' ' target  '`)).toBe(true);
    const resolverChild = conn.children[0]!;
    resolverChild.stdout.write('/remote/project/ target  \n');
    resolverChild.emit('close', 0);
    await handlerPromise;

    expect(ui.selectCalls).toHaveLength(0);
    const latestStatus = ui.statuses.filter((s) => s.key === 'ssh').at(-1)!;
    expect(latestStatus.text).toContain('/remote/project/ target  ');
    expect(ui.notifications.filter((n) => n.kind === 'info')).toEqual([
      { message: 'Remote working directory: /remote/project/ target  ', kind: 'info' },
    ]);

    const bash = handlers.user_bash![0]!({}, ctx) as BashOps;
    const execPromise = bash.operations.exec('echo after', process.cwd(), { onData: () => {} });
    expect(conn.spawnCalls[1]!.command).toBe("cd -- '/remote/project/ target  ' && echo after");
    conn.children[1]!.emit('close', 0);
    await execPromise;
  });

  it('preserves backslashes in POSIX directory names', async () => {
    const { commands, ctx, connections, handlers } = makeHarness('user@host:/remote/project');
    await handlers.session_start![0]!({}, ctx);
    const conn = connections[0]!;
    const command = getRegisteredCommand(commands, 'ssh:cwd');

    const completionPromise = command.getArgumentCompletions!('');
    const listChild = conn.children[0]!;
    listChild.stdout.write('docs\\api\n');
    listChild.emit('close', 0);
    const items = await completionPromise;

    expect(items).toEqual([
      { value: '..', label: '..' },
      { value: 'docs\\api', label: 'docs\\api' },
    ]);
  });

  it('orders tied directory candidates by Unicode code point', async () => {
    const { commands, ctx, connections, handlers } = makeHarness('user@host:/remote/project');
    await handlers.session_start![0]!({}, ctx);
    const conn = connections[0]!;
    const command = getRegisteredCommand(commands, 'ssh:cwd');

    // Same-tier candidates: BMP U+E000 and supplementary-plane U+10000. UTF-16 code-unit
    // order puts U+10000 (high surrogate 0xD800) before U+E000; Unicode code-point order
    // puts 0xE000 before 0x10000.
    const completionPromise = command.getArgumentCompletions!('');
    const listChild = conn.children[0]!;
    listChild.stdout.write('./caf\uE000\n./caf\u{10000}\n');
    listChild.emit('close', 0);
    const items = await completionPromise;

    expect(items).toEqual([
      { value: '..', label: '..' },
      { value: 'caf\uE000', label: 'caf\uE000' },
      { value: 'caf\u{10000}', label: 'caf\u{10000}' },
    ]);
  });

  it('preserves replacement tokens in cwd used by subsequent remote tools', async () => {
    const { commands, ctx, connections, getTool, handlers } = makeHarness(
      'user@host:/remote/project'
    );
    await handlers.session_start![0]!({}, ctx);
    const conn = connections[0]!;
    const command = getRegisteredCommand(commands, 'ssh:cwd');

    // Resolver returns an absolute path containing all three JS String.replace
    // replacement tokens: $& (matched text), $` (before-match), $' (after-match).
    const switchPromise = command.handler('target', ctx);
    const resolverChild = conn.children[0]!;
    resolverChild.stdout.write("/remote/proj $& $` $'\n");
    resolverChild.emit('close', 0);
    await switchPromise;

    // Registered bash tool: cd -- must receive the token cwd verbatim.
    const bashTool = getTool('bash') as RegisteredBashTool;
    const bashPromise = bashTool.execute(
      'token-cwd-bash',
      { command: 'echo token-bash' },
      undefined,
      undefined
    );
    expect(conn.spawnCalls[1]!.command).toBe(
      "cd -- '/remote/proj $& $` $'\"'\"'' && echo token-bash"
    );
    expect(conn.spawnCalls[1]!.command).not.toContain(process.cwd());
    conn.children[1]!.emit('close', 0);
    await bashPromise;

    // Registered read tool: remote cwd and file suffix must each appear exactly once.
    const readTool = getTool('read') as {
      execute: (
        id: string,
        params: { path: string },
        signal: unknown,
        onUpdate: unknown
      ) => Promise<unknown>;
    };
    const readPromise = readTool.execute(
      'token-cwd-read',
      { path: 'notes.md' },
      undefined,
      undefined
    );
    expect(await untilSpawn(conn, 2)).toBe("test -r '/remote/proj $& $` $'\"'\"'/notes.md'");
    conn.children[2]!.emit('close', 0);
    expect(await untilSpawn(conn, 3)).toBe(
      "file --mime-type -b '/remote/proj $& $` $'\"'\"'/notes.md'"
    );
    conn.children[3]!.emit('close', 0);
    expect(await untilSpawn(conn, 4)).toBe("cat -- '/remote/proj $& $` $'\"'\"'/notes.md'");
    conn.children[4]!.stdout.write('hello token cwd\n');
    conn.children[4]!.emit('close', 0);
    await readPromise;
  });
});

describe('registerPiRemote hostile cwd quoting', () => {
  it('quotes hostile cwd data for user and tool bash execution', async () => {
    const { ctx, connections, getTool, handlers } = makeHarness(`user@host:${HOSTILE_CWD}`);
    await handlers.session_start![0]!({}, ctx);
    const conn = connections[0]!;

    const userBash = handlers.user_bash![0]!({}, ctx) as BashOps;
    const userPromise = userBash.operations.exec('echo user', process.cwd(), {
      onData: () => {},
    });
    const userCmd = conn.spawnCalls[0]!.command;
    expect(userCmd).toBe(`cd -- ${QUOTED_HOSTILE_CWD} && echo user`);
    expect(userCmd).not.toContain(`cd "${HOSTILE_CWD}`);

    const bashTool = getTool('bash') as RegisteredBashTool;
    const toolPromise = bashTool.execute(
      'hostile-bash-tool',
      { command: 'echo tool' },
      undefined,
      undefined
    );
    const toolCmd = conn.spawnCalls[1]!.command;
    expect(toolCmd).toBe(`cd -- ${QUOTED_HOSTILE_CWD} && echo tool`);
    expect(toolCmd).not.toContain(`cd "${HOSTILE_CWD}`);

    conn.children[0]!.emit('close', 0);
    await userPromise;
    conn.children[1]!.emit('close', 0);
    await toolPromise;
  });

  it('quotes hostile cwd data for read and write operations', async () => {
    const { ctx, connections, getTool, handlers } = makeHarness(`user@host:${HOSTILE_CWD}`);
    await handlers.session_start![0]!({}, ctx);
    const conn = connections[0]!;
    const readTool = getTool('read') as {
      execute: (
        id: string,
        params: { path: string },
        signal: unknown,
        onUpdate: unknown
      ) => Promise<unknown>;
    };
    const writeTool = getTool('write') as {
      execute: (
        id: string,
        params: { path: string; content: string },
        signal: unknown,
        onUpdate: unknown
      ) => Promise<unknown>;
    };
    const qNotes = "'/remote/proj $(touch /tmp/pwned) `id` $HOME; echo '\"'\"'hi'\"'\"'/notes.md'";
    const qDocs = "'/remote/proj $(touch /tmp/pwned) `id` $HOME; echo '\"'\"'hi'\"'\"'/docs'";
    const qDocsNotes =
      "'/remote/proj $(touch /tmp/pwned) `id` $HOME; echo '\"'\"'hi'\"'\"'/docs/notes.md'";
    const qNope = "'/remote/proj $(touch /tmp/pwned) `id` $HOME; echo '\"'\"'hi'\"'\"'/nope.md'";

    const readPromise = readTool.execute(
      'hostile-read',
      { path: 'notes.md' },
      undefined,
      undefined
    );
    expect(await untilSpawn(conn, 0)).toBe(`test -r ${qNotes}`);
    conn.children[0]!.emit('close', 0);
    expect(await untilSpawn(conn, 1)).toBe(`file --mime-type -b ${qNotes}`);
    conn.children[1]!.emit('close', 0);
    expect(await untilSpawn(conn, 2)).toBe(`cat -- ${qNotes}`);
    conn.children[2]!.stdout.write('hello content\n');
    conn.children[2]!.emit('close', 0);
    expect(JSON.stringify(await readPromise)).toContain('hello content');

    const content = 'hello write';
    // Known base64 of the fixed content above; kept as a literal, not recomputed.
    const b64 = 'aGVsbG8gd3JpdGU=';
    const writePromise = writeTool.execute(
      'hostile-write',
      { path: 'docs/notes.md', content },
      undefined,
      undefined
    );
    expect(await untilSpawn(conn, 3)).toBe(`mkdir -p -- ${qDocs}`);
    conn.children[3]!.emit('close', 0);
    expect(await untilSpawn(conn, 4)).toBe(`printf %s '${b64}' | base64 -d > ${qDocsNotes}`);
    conn.children[4]!.emit('close', 0);
    await writePromise;

    const failPromise = readTool.execute(
      'hostile-read-missing',
      { path: 'nope.md' },
      undefined,
      undefined
    );
    expect(await untilSpawn(conn, 5)).toBe(`test -r ${qNope}`);
    conn.children[5]!.emit('close', 1);
    const failError = await captureError(failPromise);
    expect(failError.message).toContain('SSH failed');

    for (const call of conn.spawnCalls) {
      expect(call.command).not.toContain(`"${HOSTILE_CWD}`);
    }
  });

  it('quotes hostile cwd data for remote grep', async () => {
    const { ctx, connections, getTool, handlers } = makeHarness(`user@host:${HOSTILE_CWD}`);
    await handlers.session_start![0]!({}, ctx);
    const conn = connections[0]!;
    const grepTool = getTool('grep') as {
      execute: (
        id: string,
        params: { pattern: string; path?: string; glob?: string },
        signal: unknown,
        onUpdate: unknown
      ) => Promise<unknown>;
    };

    const pattern = "it('works') $(id)";
    const glob = "'**/*.ts";
    const grepPromise = grepTool.execute(
      'hostile-grep',
      { pattern, glob, path: 'src' },
      undefined,
      undefined
    );
    const grepCmd = conn.spawnCalls[0]!.command;
    expect(grepCmd.startsWith('rg ')).toBe(true);
    expect(grepCmd).toContain("'--json'");
    expect(grepCmd).toContain("'--line-number'");
    expect(grepCmd).toContain("'--color=never'");
    expect(grepCmd).toContain("'--hidden'");
    expect(grepCmd).toContain("'--glob'");
    expect(grepCmd).toContain("'--'");
    expect(grepCmd).toContain("'it('\"'\"'works'\"'\"') $(id)'");
    expect(grepCmd).toContain(
      "'/remote/proj $(touch /tmp/pwned) `id` $HOME; echo '\"'\"'hi'\"'\"'/src'"
    );
    conn.children[0]!.stdout.write(
      `${JSON.stringify({
        type: 'match',
        data: {
          path: { text: `${HOSTILE_CWD}/src/main.ts` },
          line_number: 1,
          lines: { text: `${pattern}\n` },
        },
      })}\n`
    );
    conn.children[0]!.emit('close', 0);
    expect(JSON.stringify(await grepPromise)).toContain('main.ts:1:');
  });

  it('quotes hostile cwd data for remote find', async () => {
    const { ctx, connections, getTool, handlers } = makeHarness(`user@host:${HOSTILE_CWD}`);
    await handlers.session_start![0]!({}, ctx);
    const conn = connections[0]!;
    const findTool = getTool('find') as {
      execute: (
        id: string,
        params: { path: string; pattern: string },
        signal: unknown,
        onUpdate: unknown
      ) => Promise<unknown>;
    };

    const pattern = "'*.ts";
    const searchPath = `${HOSTILE_CWD}/src`;
    const qSearchPath = "'/remote/proj $(touch /tmp/pwned) `id` $HOME; echo '\"'\"'hi'\"'\"'/src'";
    const findPromise = findTool.execute(
      'hostile-find',
      { path: 'src', pattern },
      undefined,
      undefined
    );
    expect(conn.spawnCalls[0]!.command).toBe(`test -e ${qSearchPath}`);
    conn.children[0]!.emit('close', 0);

    const findCmd = await untilSpawn(conn, 1);
    expect(findCmd.startsWith('bash -c ')).toBe(true);
    expect(findCmd).toContain('rg --files --hidden --color=never');
    expect(findCmd).toContain('-- . | head -n 1000');
    expect(findCmd).toContain("-g '\"'\"'!**/node_modules/**'\"'\"'");
    expect(findCmd).toContain("-g '\"'\"'!**/.git/**'\"'\"'");
    expect(findCmd).toContain('$(touch /tmp/pwned)');
    expect(findCmd).not.toContain(`"${searchPath}`);
    conn.children[1]!.stdout.write('src/main.ts\n');
    conn.children[1]!.emit('close', 0);
    expect(JSON.stringify(await findPromise)).toContain('main.ts');
  });

  it('quotes hostile cwd data for remote ls', async () => {
    const { ctx, connections, getTool, handlers } = makeHarness(`user@host:${HOSTILE_CWD}`);
    await handlers.session_start![0]!({}, ctx);
    const conn = connections[0]!;
    const lsTool = getTool('ls') as {
      execute: (
        id: string,
        params: { path: string },
        signal: unknown,
        onUpdate: unknown
      ) => Promise<unknown>;
    };
    const qSrc = "'/remote/proj $(touch /tmp/pwned) `id` $HOME; echo '\"'\"'hi'\"'\"'/src'";
    const qSrcDocs =
      "'/remote/proj $(touch /tmp/pwned) `id` $HOME; echo '\"'\"'hi'\"'\"'/src/docs'";
    // Template over pre-quoted literals; no escaping computed here.
    const statScript = (p: string) =>
      `if test -d ${p}; then echo dir; elif test -e ${p}; then echo file; else echo missing; fi`;

    const lsPromise = lsTool.execute('hostile-ls', { path: 'src' }, undefined, undefined);
    expect(conn.spawnCalls[0]!.command).toBe(`test -e ${qSrc}`);
    conn.children[0]!.emit('close', 0);
    expect(await untilSpawn(conn, 1)).toBe(statScript(qSrc));
    conn.children[1]!.stdout.write('dir\n');
    conn.children[1]!.emit('close', 0);
    expect(await untilSpawn(conn, 2)).toBe(`ls -1A -- ${qSrc}`);
    conn.children[2]!.stdout.write('docs\n');
    conn.children[2]!.emit('close', 0);
    expect(await untilSpawn(conn, 3)).toBe(statScript(qSrcDocs));
    conn.children[3]!.stdout.write('dir\n');
    conn.children[3]!.emit('close', 0);
    expect(JSON.stringify(await lsPromise)).toContain('docs/');

    for (const call of conn.spawnCalls) {
      expect(call.command).not.toContain(`"${HOSTILE_CWD}`);
    }
  });

  it('quotes hostile cwd data for remote at completion', async () => {
    const { ctx, connections, handlers, ui } = makeHarness(`user@host:${HOSTILE_CWD}`);
    await handlers.session_start![0]!({}, ctx);
    const conn = connections[0]!;

    const currentProvider = makeAutocompleteProviderStub();
    const provider = (ui.providers[0] as (current: AutocompleteProvider) => AutocompleteProvider)(
      currentProvider
    );
    const suggestionsPromise = provider.getSuggestions(['@'], 0, 1, {
      signal: new AbortController().signal,
    });
    const cmd = conn.spawnCalls[0]!.command;
    expect(cmd.startsWith('bash -c ')).toBe(true);
    expect(cmd).toContain('fd --type d');
    expect(cmd).toContain('fd --type f');
    expect(cmd).toContain("'\"'\"'--base-directory'\"'\"'");
    expect(cmd).toContain('$(touch /tmp/pwned)');
    expect(cmd).toContain('`id`');
    expect(cmd).not.toContain(`"${HOSTILE_CWD}`);
    conn.children[0]!.stdout.write('1 src\n');
    conn.children[0]!.emit('close', 0);
    const suggestions = await suggestionsPromise;
    expect(suggestions?.items).toEqual([{ value: '@src/', label: 'src/', description: 'src' }]);
  });

  it('trims whitespace in pathless startup pwd output', async () => {
    const { handlers, ui, ctx, connections } = makeHarness('user@host');
    const startHandler = handlers.session_start![0]!;
    const startPromise = startHandler({}, ctx);
    await Promise.resolve();

    const conn = connections[0]!;
    conn.children[0]!.stdout.write('/remote/project  \r\n');
    conn.children[0]!.emit('close', 0);
    await startPromise;

    const status = ui.statuses.find((s) => s.key === 'ssh')!;
    expect(status.text).toContain('/remote/project');
    expect(status.text).not.toContain('/remote/project  ');

    const bash = handlers.user_bash![0]!({}, ctx) as BashOps;
    const execPromise = bash.operations.exec('echo after', process.cwd(), { onData: () => {} });
    expect(conn.spawnCalls[1]!.command).toBe("cd -- '/remote/project' && echo after");
    conn.children[1]!.emit('close', 0);
    await execPromise;
  });

  it('preserves valid spaces in resolved remote pwd output', async () => {
    const { commands, ctx, connections, handlers, ui } = makeHarness('user@host:/remote/project');
    await handlers.session_start![0]!({}, ctx);
    const conn = connections[0]!;
    const command = getRegisteredCommand(commands, 'ssh:cwd');

    const handlerPromise = command.handler('target', ctx);
    const resolverChild = conn.children[0]!;
    resolverChild.stdout.write('/remote/project/target  \r\n');
    resolverChild.emit('close', 0);
    await handlerPromise;

    const latestStatus = ui.statuses.filter((s) => s.key === 'ssh').at(-1)!;
    expect(latestStatus.text).toContain('/remote/project/target  ');
    expect(ui.notifications.filter((n) => n.kind === 'info')).toEqual([
      { message: 'Remote working directory: /remote/project/target  ', kind: 'info' },
    ]);

    const bash = handlers.user_bash![0]!({}, ctx) as BashOps;
    const execPromise = bash.operations.exec('echo after', process.cwd(), { onData: () => {} });
    expect(conn.spawnCalls[1]!.command).toBe("cd -- '/remote/project/target  ' && echo after");
    conn.children[1]!.emit('close', 0);
    await execPromise;
  });
});

describe('registerPiRemote /ssh command', () => {
  it('registers a ssh command', () => {
    const { commands } = makeHarness('');
    const names = commands.map((c) => (c as SshCommand).name);
    expect(names).toContain('ssh');
  });

  it('connects with a manual target and port', async () => {
    const { commands, ctx, connections, connectionArgs, ui } = makeHarness('');
    const handler = getRegisteredCommand(commands, 'ssh');
    await handler.handler('user@host:/remote/path -p 2222', ctx);

    expect(connectionArgs).toEqual([{ remote: 'user@host', port: 2222 }]);
    expect(connections).toHaveLength(1);
    expect(connections[0]!.remote).toBe('user@host');
    const status = ui.statuses.find((s) => s.key === 'ssh')!;
    expect(status.text).toContain('/remote/path');
  });

  it('rejects an invalid manual target without connecting', async () => {
    const { commands, ctx, connections, ui } = makeHarness('');
    const handler = getRegisteredCommand(commands, 'ssh');
    await handler.handler('user@host -p', ctx);
    expect(connections).toHaveLength(0);
    expect(ui.notifications.some((n) => n.kind === 'error')).toBe(true);
  });

  it('keeps the previous connection when a reconnect fails', async () => {
    const { commands, ctx, connections, handlers, ui } = makeHarness('');
    const handler = getRegisteredCommand(commands, 'ssh');

    await handler.handler('user@a:/p1', ctx);
    const first = connections[0]!;

    const reconnect = handler.handler('user@b', ctx);
    await Promise.resolve();
    const second = connections[1]!;
    const child = second.children[0]!;
    child.stderr.write('refused');
    child.emit('close', SSH_FAILURE_EXIT_CODE);
    await reconnect;

    expect(second.closeCalls).toBe(1);
    expect(first.closeCalls).toBe(0);
    expect(handlers.user_bash![0]!({}, ctx)).not.toBeUndefined();
    const errorNotify = ui.notifications.find((n) => n.kind === 'error')!;
    expect(errorNotify.message).toBe(
      'SSH connection failed: user@b: refused (kept previous connection)'
    );
  });
});

async function assertFailedPathlessStartup(cleanupError?: Error) {
  const { handlers, ui, tools, ctx, connections } = makeHarness('user@host');
  const startHandler = handlers.session_start![0]!;
  const startPromise = startHandler({}, ctx);
  await Promise.resolve();

  const conn = connections[0]!;
  if (cleanupError) conn.failClose(cleanupError);
  const child = conn.children[0]!;
  child.stderr.write('Permission denied');
  child.emit('close', SSH_FAILURE_EXIT_CODE);
  await startPromise;

  expect(conn.spawnCalls.map((c) => c.command)).toEqual(['pwd']);
  expect(conn.closeCalls).toBe(1);
  expect(tools).toHaveLength(0);
  expect(ui.providers).toHaveLength(0);
  const status = ui.statuses.find((s) => s.key === 'ssh')!;
  expect(status.text).toContain('user@host');
  const errorNotify = ui.notifications.find((n) => n.kind === 'error')!;
  expect(errorNotify.message).toBe(
    'SSH connection failed: cannot reach user@host: Permission denied'
  );
  if (cleanupError) {
    expect(errorNotify.message).not.toContain(cleanupError.message);
  }
}

type ToolExecute = (
  id: string,
  params: { path: string; pattern?: string; limit?: number },
  signal: unknown,
  onUpdate: unknown
) => Promise<unknown>;

async function captureError(promise: Promise<unknown>): Promise<Error> {
  const settled = await promise.then(
    () => null,
    (error: unknown) => error
  );
  return settled as Error;
}

async function assertMissingPathRule(scenario: MissingPathScenario): Promise<void> {
  const { handlers, ctx, connections, getTool } = makeHarness('user@host:/remote/path');
  await handlers.session_start![0]!({}, ctx);
  const conn = connections[0]!;
  const tool = getTool(scenario.toolName) as { execute: ToolExecute };

  const transport = tool.execute('missing-path-transport', scenario.input, undefined, undefined);
  const transportChild = conn.children[0]!;
  transportChild.stderr.write(scenario.transportStderr);
  transportChild.emit('close', SSH_FAILURE_EXIT_CODE);
  const transportError = await captureError(transport);
  expect(transportError.message).toBe(scenario.expectedTransportError);
  expect(transportError.message).not.toContain('Path not found');
  expect(conn.spawnCalls).toHaveLength(1);
  expect(conn.spawnCalls[0]!.command.startsWith('test -e ')).toBe(true);

  const missing = tool.execute(
    'missing-path-not-found',
    { ...scenario.input, path: 'missing' },
    undefined,
    undefined
  );
  const missingChild = conn.children[1]!;
  missingChild.emit('close', 1);
  const missingError = await captureError(missing);
  expect(missingError.message).toContain('Path not found: ');
  expect(missingError.message).toContain(path.resolve(process.cwd(), 'missing'));
  expect(conn.spawnCalls).toHaveLength(2);
  for (const call of conn.spawnCalls) {
    expect(call.command.includes(scenario.forbiddenFollowUpCommand)).toBe(false);
  }
}

type MissingPathScenario = {
  toolName: 'ls' | 'find';
  input: { path: string; pattern?: string };
  forbiddenFollowUpCommand: string;
  transportStderr: string;
  expectedTransportError: string;
};

const missingPathScenarios: MissingPathScenario[] = [
  {
    toolName: 'ls',
    input: { path: 'lost' },
    forbiddenFollowUpCommand: 'ls -1A',
    transportStderr: 'Connection reset',
    expectedTransportError: 'SSH failed (255): Connection reset',
  },
  {
    toolName: 'find',
    input: { pattern: '*.ts', path: 'lost' },
    forbiddenFollowUpCommand: 'rg --files',
    transportStderr: 'Broken pipe',
    expectedTransportError: 'SSH failed (255): Broken pipe',
  },
];

describe('registerPiRemote missing-path rule', () => {
  for (const scenario of missingPathScenarios) {
    it(`${scenario.toolName} treats only test status 1 as a missing path`, async () => {
      await assertMissingPathRule(scenario);
    });
  }

  it('ls propagates SSH process errors', async () => {
    const { handlers, ctx, connections, getTool } = makeHarness('user@host:/remote/path');
    await handlers.session_start![0]!({}, ctx);
    const conn = connections[0]!;
    const lsTool = getTool('ls') as { execute: ToolExecute };

    const processError = lsTool.execute(
      'ls-process-error',
      { path: 'broken' },
      undefined,
      undefined
    );
    const brokenChild = conn.children[0]!;
    brokenChild.emit('error', new Error('ssh process failed'));
    const processFailure = await captureError(processError);
    expect(processFailure.message).toBe('ssh process failed');
    expect(conn.spawnCalls).toHaveLength(1);
  });
});
