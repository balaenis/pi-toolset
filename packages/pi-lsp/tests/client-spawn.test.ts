// ABOUTME: Tests for Windows spawn invocation resolution in client.ts.
// ABOUTME: Covers batch-shim shell routing and cmd.exe arg quoting.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { quoteWindowsArg, resolveSpawnInvocation } from '../src/client.ts';

const isWindows = process.platform === 'win32';

describe('quoteWindowsArg', () => {
  it('passes through simple tokens unchanged', () => {
    expect(quoteWindowsArg('--stdio')).toBe('--stdio');
    expect(quoteWindowsArg('start')).toBe('start');
    expect(quoteWindowsArg('typescript-language-server')).toBe('typescript-language-server');
  });

  it('quotes tokens containing whitespace', () => {
    expect(quoteWindowsArg('has space')).toBe('"has space"');
  });

  it('quotes and doubles embedded double quotes', () => {
    expect(quoteWindowsArg('a"b')).toBe('"a""b"');
  });

  it('quotes tokens containing cmd.exe metacharacters', () => {
    expect(quoteWindowsArg('a&b')).toBe('"a&b"');
    expect(quoteWindowsArg('a(b)c')).toBe('"a(b)c"');
  });

  it('renders an empty token as an empty quoted string', () => {
    expect(quoteWindowsArg('')).toBe('""');
  });
});

describe('resolveSpawnInvocation', () => {
  it('keeps direct spawn (no shell) on non-Windows', () => {
    if (isWindows) return; // non-Windows invariant only
    const inv = resolveSpawnInvocation('typescript-language-server', ['--stdio']);
    expect(inv).toEqual({ command: 'typescript-language-server', args: ['--stdio'], shell: false });
  });

  describe('on Windows', () => {
    let tmp: string;

    beforeAll(() => {
      tmp = mkdtempSync(path.join(os.tmpdir(), 'pi-lsp-client-spawn-'));
    });

    afterAll(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    it('routes .cmd shims through shell mode with a single command string', () => {
      if (!isWindows) return;
      const dir = path.join(tmp, 'cmd-bin');
      mkdirSync(dir, { recursive: true });
      const cmdPath = path.join(dir, 'fake-lsp.cmd');
      writeFileSync(cmdPath, '@echo off\r\nexit /b 0\r\n');

      const inv = resolveSpawnInvocation('fake-lsp', ['--stdio'], dir);
      expect(inv.shell).toBe(true);
      expect(inv.args).toBeUndefined();
      // Single string: the resolved .cmd path followed by the bare flag.
      expect(inv.command).toBe(`${cmdPath} --stdio`);
    });

    it('quotes the .cmd path when it contains spaces', () => {
      if (!isWindows) return;
      const dir = path.join(tmp, 'with space', 'bin');
      mkdirSync(dir, { recursive: true });
      const cmdPath = path.join(dir, 'fake-lsp.cmd');
      writeFileSync(cmdPath, '@echo off\r\nexit /b 0\r\n');

      const inv = resolveSpawnInvocation('fake-lsp', ['--stdio'], dir);
      expect(inv.shell).toBe(true);
      expect(inv.args).toBeUndefined();
      expect(inv.command).toBe(`"${cmdPath}" --stdio`);
    });

    it('keeps direct spawn for .exe executables', () => {
      if (!isWindows) return;
      const dir = path.join(tmp, 'exe-bin');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'rust-analyzer.exe'), '');

      const inv = resolveSpawnInvocation('rust-analyzer', ['--stdio'], dir);
      expect(inv.shell).toBe(false);
      expect(inv.args).toEqual(['--stdio']);
      expect(inv.command).toBe('rust-analyzer');
    });

    it('keeps direct spawn when the command is not found (preserves ENOENT)', () => {
      if (!isWindows) return;
      const inv = resolveSpawnInvocation('definitely-missing-zz', ['--stdio'], tmp);
      expect(inv.shell).toBe(false);
      expect(inv.args).toEqual(['--stdio']);
      expect(inv.command).toBe('definitely-missing-zz');
    });
  });
});
