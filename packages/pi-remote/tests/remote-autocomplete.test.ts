// ABOUTME: Verifies remote @ file-completion: pure suggestion building, directory derivation, and the provider factory.
// ABOUTME: Uses an injected listRemoteFiles and a mock current provider; no live SSH in unit tests.
import { describe, expect, it, mock } from 'bun:test';
import {
  createRemoteAtAutocompleteFactory,
  deriveDirectoriesFromFiles,
  getRemoteAtSuggestions,
  REMOTE_AT_MAX_RESULTS,
  type ListRemoteFiles,
  type ListRemoteFilesRequest,
  type RemoteFileEntry,
} from '../src/remote-autocomplete.ts';

const LOCAL_CWD = '/home/u/proj';
const REMOTE_CWD = '/root/proj';

function makeLister(entries: RemoteFileEntry[]) {
  const calls: ListRemoteFilesRequest[] = [];
  const listRemoteFiles: ListRemoteFiles = (request) => {
    calls.push(request);
    return Promise.resolve(entries);
  };
  return { listRemoteFiles, calls };
}

function baseOptions(listRemoteFiles: ListRemoteFiles, signal: AbortSignal) {
  return { localCwd: LOCAL_CWD, remoteCwd: REMOTE_CWD, signal, listRemoteFiles };
}

describe('getRemoteAtSuggestions', () => {
  it('lists files under remoteCwd for a bare @', async () => {
    const { listRemoteFiles, calls } = makeLister([
      { relativePath: 'src/a.ts', isDirectory: false },
      { relativePath: 'README.md', isDirectory: false },
    ]);
    const items = await getRemoteAtSuggestions(
      '@',
      baseOptions(listRemoteFiles, new AbortController().signal)
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.searchRoot).toBe(REMOTE_CWD);
    expect(calls[0]!.query).toBe('');
    expect(items).toContainEqual({ value: '@src/a.ts', label: 'a.ts', description: 'src/a.ts' });
    expect(items).toContainEqual({
      value: '@README.md',
      label: 'README.md',
      description: 'README.md',
    });
  });

  it('filters @query to matching paths and passes the query to the lister', async () => {
    const { listRemoteFiles, calls } = makeLister([
      { relativePath: 'src/a.ts', isDirectory: false },
      { relativePath: 'lib/z.ts', isDirectory: false },
    ]);
    const items = await getRemoteAtSuggestions(
      '@a',
      baseOptions(listRemoteFiles, new AbortController().signal)
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toBe('a');
    expect(calls[0]!.searchRoot).toBe(REMOTE_CWD);
    expect(items).toEqual([{ value: '@src/a.ts', label: 'a.ts', description: 'src/a.ts' }]);
  });

  it('scopes @dir/ to the directory under remoteCwd with relative display values', async () => {
    const { listRemoteFiles, calls } = makeLister([{ relativePath: 'a.ts', isDirectory: false }]);
    const items = await getRemoteAtSuggestions(
      '@src/',
      baseOptions(listRemoteFiles, new AbortController().signal)
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.searchRoot).toBe(`${REMOTE_CWD}/src`);
    expect(calls[0]!.query).toBe('');
    expect(items).toEqual([{ value: '@src/a.ts', label: 'a.ts', description: 'src/a.ts' }]);
  });

  it('scopes @dir/query and keeps the directory prefix in display values', async () => {
    const { listRemoteFiles, calls } = makeLister([
      { relativePath: 'a.ts', isDirectory: false },
      { relativePath: 'b.ts', isDirectory: false },
    ]);
    const items = await getRemoteAtSuggestions(
      '@src/a',
      baseOptions(listRemoteFiles, new AbortController().signal)
    );

    expect(calls[0]!.searchRoot).toBe(`${REMOTE_CWD}/src`);
    expect(calls[0]!.query).toBe('a');
    expect(items).toEqual([{ value: '@src/a.ts', label: 'a.ts', description: 'src/a.ts' }]);
  });

  it('maps a local-absolute @prefix to the remote cwd', async () => {
    const { listRemoteFiles, calls } = makeLister([{ relativePath: 'a.ts', isDirectory: false }]);
    const items = await getRemoteAtSuggestions(
      '@/home/u/proj/src/',
      baseOptions(listRemoteFiles, new AbortController().signal)
    );

    expect(calls[0]!.searchRoot).toBe(`${REMOTE_CWD}/src`);
    expect(items).toEqual([
      { value: '@/root/proj/src/a.ts', label: 'a.ts', description: '/root/proj/src/a.ts' },
    ]);
  });

  it('passes a pure remote-absolute @prefix through unchanged', async () => {
    const { listRemoteFiles, calls } = makeLister([{ relativePath: 'hosts', isDirectory: false }]);
    const items = await getRemoteAtSuggestions(
      '@/etc/',
      baseOptions(listRemoteFiles, new AbortController().signal)
    );

    expect(calls[0]!.searchRoot).toBe('/etc');
    expect(items).toEqual([{ value: '@/etc/hosts', label: 'hosts', description: '/etc/hosts' }]);
  });

  it('ends directory values and labels with a trailing slash', async () => {
    const { listRemoteFiles } = makeLister([
      { relativePath: 'src', isDirectory: true },
      { relativePath: 'README.md', isDirectory: false },
    ]);
    const items = await getRemoteAtSuggestions(
      '@',
      baseOptions(listRemoteFiles, new AbortController().signal)
    );

    expect(items).toContainEqual({ value: '@src/', label: 'src/', description: 'src' });
    expect(items).toContainEqual({
      value: '@README.md',
      label: 'README.md',
      description: 'README.md',
    });
  });

  it('caps results at REMOTE_AT_MAX_RESULTS', async () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({
      relativePath: `f${i}.ts`,
      isDirectory: false,
    }));
    const { listRemoteFiles } = makeLister(entries);
    const items = await getRemoteAtSuggestions(
      '@',
      baseOptions(listRemoteFiles, new AbortController().signal)
    );

    expect(items.length).toBe(REMOTE_AT_MAX_RESULTS);
  });

  it('returns [] without calling the lister when the signal is already aborted', async () => {
    const { listRemoteFiles, calls } = makeLister([{ relativePath: 'a.ts', isDirectory: false }]);
    const controller = new AbortController();
    controller.abort();
    const items = await getRemoteAtSuggestions(
      '@',
      baseOptions(listRemoteFiles, controller.signal)
    );

    expect(items).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('returns [] when the signal aborts while listing', async () => {
    const controller = new AbortController();
    const listRemoteFiles: ListRemoteFiles = () => {
      controller.abort();
      return Promise.resolve([{ relativePath: 'a.ts', isDirectory: false }]);
    };
    const items = await getRemoteAtSuggestions(
      '@',
      baseOptions(listRemoteFiles, controller.signal)
    );

    expect(items).toEqual([]);
  });

  it('returns [] when the lister returns no entries', async () => {
    const { listRemoteFiles } = makeLister([]);
    const items = await getRemoteAtSuggestions(
      '@',
      baseOptions(listRemoteFiles, new AbortController().signal)
    );

    expect(items).toEqual([]);
  });
});

describe('createRemoteAtAutocompleteFactory', () => {
  const CURRENT_ITEM = { value: '@local.ts', label: 'local.ts', description: 'local.ts' };
  const signal = () => new AbortController().signal;

  function makeCurrent() {
    return {
      getSuggestions: mock(async () => ({ items: [CURRENT_ITEM], prefix: '@local.ts' })),
      applyCompletion: mock((lines: string[], cursorLine: number, cursorCol: number) => ({
        lines,
        cursorLine,
        cursorCol,
      })),
      shouldTriggerFileCompletion: mock(() => true),
    };
  }

  function makeFactory(
    getSsh: () => { remoteCwd: string } | null,
    listRemoteFiles: ListRemoteFiles
  ) {
    return createRemoteAtAutocompleteFactory({ getSsh, localCwd: LOCAL_CWD, listRemoteFiles });
  }

  it('delegates to current and skips the lister when SSH is inactive', async () => {
    const current = makeCurrent();
    const { listRemoteFiles, calls } = makeLister([]);
    const provider = makeFactory(() => null, listRemoteFiles)(current);

    const result = await provider.getSuggestions(['hello @src'], 0, 10, { signal: signal() });

    expect(current.getSuggestions).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ items: [CURRENT_ITEM], prefix: '@local.ts' });
    expect(calls).toHaveLength(0);
  });

  it('intercepts @ tokens with remote suggestions when SSH is active', async () => {
    const current = makeCurrent();
    const { listRemoteFiles, calls } = makeLister([
      { relativePath: 'src/a.ts', isDirectory: false },
    ]);
    const provider = makeFactory(() => ({ remoteCwd: REMOTE_CWD }), listRemoteFiles)(current);

    const result = await provider.getSuggestions(['hello @src'], 0, 10, { signal: signal() });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.searchRoot).toBe(REMOTE_CWD);
    expect(calls[0]!.query).toBe('src');
    expect(result).toEqual({
      items: [{ value: '@src/a.ts', label: 'a.ts', description: 'src/a.ts' }],
      prefix: '@src',
    });
    expect(current.getSuggestions).not.toHaveBeenCalled();
  });

  it('still delegates slash commands and non-@ tokens to current when SSH is active', async () => {
    const current = makeCurrent();
    const { listRemoteFiles, calls } = makeLister([]);
    const provider = makeFactory(() => ({ remoteCwd: REMOTE_CWD }), listRemoteFiles)(current);

    const slash = await provider.getSuggestions(['/help'], 0, 5, { signal: signal() });
    const plain = await provider.getSuggestions(['foo bar'], 0, 7, { signal: signal() });

    expect(slash).toEqual({ items: [CURRENT_ITEM], prefix: '@local.ts' });
    expect(plain).toEqual({ items: [CURRENT_ITEM], prefix: '@local.ts' });
    expect(current.getSuggestions).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(0);
  });

  it('returns null instead of remote items when remote suggestions are empty', async () => {
    const current = makeCurrent();
    const { listRemoteFiles } = makeLister([]);
    const provider = makeFactory(() => ({ remoteCwd: REMOTE_CWD }), listRemoteFiles)(current);

    const result = await provider.getSuggestions(['hello @src'], 0, 10, { signal: signal() });

    expect(result).toBeNull();
    expect(current.getSuggestions).not.toHaveBeenCalled();
  });

  it('returns null instead of throwing when the lister rejects', async () => {
    const current = makeCurrent();
    const failing: ListRemoteFiles = () => Promise.reject(new Error('ssh down'));
    const provider = makeFactory(() => ({ remoteCwd: REMOTE_CWD }), failing)(current);

    const result = await provider.getSuggestions(['hello @src'], 0, 10, { signal: signal() });

    expect(result).toBeNull();
  });

  it('forwards applyCompletion and shouldTriggerFileCompletion to current', () => {
    const current = makeCurrent();
    const { listRemoteFiles } = makeLister([]);
    const provider = makeFactory(() => ({ remoteCwd: REMOTE_CWD }), listRemoteFiles)(current);
    const lines = ['hello @src'];
    const item = { value: '@src/a.ts', label: 'a.ts', description: 'src/a.ts' };

    const completion = provider.applyCompletion(lines, 0, 10, item, '@src');
    const trigger = provider.shouldTriggerFileCompletion?.(lines, 0, 10);

    expect(current.applyCompletion).toHaveBeenCalledWith(lines, 0, 10, item, '@src');
    expect(completion).toEqual({ lines, cursorLine: 0, cursorCol: 10 });
    expect(current.shouldTriggerFileCompletion).toHaveBeenCalledWith(lines, 0, 10);
    expect(trigger).toBe(true);
  });

  it('defaults shouldTriggerFileCompletion to true when current omits it', () => {
    const current = {
      getSuggestions: mock(() => Promise.resolve(null)),
      applyCompletion: mock((lines: string[]) => ({ lines, cursorLine: 0, cursorCol: 0 })),
    };
    const { listRemoteFiles } = makeLister([]);
    const provider = makeFactory(() => ({ remoteCwd: REMOTE_CWD }), listRemoteFiles)(current);

    expect(provider.shouldTriggerFileCompletion?.(['x'], 0, 1)).toBe(true);
  });
});

describe('deriveDirectoriesFromFiles', () => {
  it('derives unique ancestor directories from file paths', () => {
    expect(deriveDirectoriesFromFiles(['src/a.ts', 'src/foo/b.ts', 'README.md']).sort()).toEqual([
      'src',
      'src/foo',
    ]);
  });

  it('normalizes leading ./ and backslashes', () => {
    expect(deriveDirectoriesFromFiles(['./src\\a.ts']).sort()).toEqual(['src']);
  });
});
