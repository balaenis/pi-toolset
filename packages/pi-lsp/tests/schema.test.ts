// ABOUTME: Regression tests for native pi-schema LSP configuration schemas.
// ABOUTME: Covers optional property reuse, permissive objects, and strict value validation.

import { describe, expect, it } from 'bun:test';
import { compile } from '@earendil-works/pi-schema';
import {
  InputLspConfigSchema,
  InputScopedLspServerConfigSchema,
  LspServerBaseSchema,
  LspServerRecipeSchema,
  ScopedLspServerConfigSchema,
} from '../src/types.ts';

const base = compile(LspServerBaseSchema);
const scoped = compile(ScopedLspServerConfigSchema);
const recipe = compile(LspServerRecipeSchema);
const inputServer = compile(InputScopedLspServerConfigSchema);
const inputConfig = compile(InputLspConfigSchema);

const requiredServer = {
  command: 'language-server',
  extensionToLanguage: { '.ts': 'typescript' },
};

describe('LSP configuration schemas', () => {
  it.each([
    ['base', base],
    ['scoped', scoped],
  ] as const)(
    '%s requires command and extension mappings but no optional fields',
    (_name, schema) => {
      expect(schema.check(requiredServer)).toBe(true);
      expect(schema.check({})).toBe(false);
      expect(schema.check({ command: requiredServer.command })).toBe(false);
      expect(schema.check({ extensionToLanguage: requiredServer.extensionToLanguage })).toBe(false);
    }
  );

  it('requires recipe metadata while retaining optional base properties', () => {
    const metadata = { name: 'typescript', installHint: 'Install the language server.' };

    expect(recipe.check({ ...requiredServer, ...metadata })).toBe(true);
    expect(recipe.check(requiredServer)).toBe(false);
    expect(recipe.check({ ...requiredServer, name: metadata.name })).toBe(false);
    expect(recipe.check({ ...requiredServer, installHint: metadata.installHint })).toBe(false);
    expect(recipe.check(metadata)).toBe(false);
  });

  it('allows builtin input overrides to omit command and extension mappings', () => {
    expect(inputServer.check({})).toBe(true);
    expect(inputServer.check({ enabled: false })).toBe(true);
    expect(inputServer.check({ extensions: ['.ts'] })).toBe(true);
    expect(inputConfig.check({})).toBe(true);
    expect(inputConfig.check({ servers: {} })).toBe(true);
    expect(inputConfig.check({ servers: { typescript: { enabled: false } } })).toBe(true);
  });

  it('keeps every object schema open to extra properties', () => {
    const extra = { nested: [null, true, { value: 'custom' }] };

    expect(base.check({ ...requiredServer, extra })).toBe(true);
    expect(scoped.check({ ...requiredServer, extra })).toBe(true);
    expect(
      recipe.check({ ...requiredServer, name: 'custom', installHint: 'Install it.', extra })
    ).toBe(true);
    expect(inputServer.check({ extra })).toBe(true);
    expect(inputConfig.check({ extra, servers: { custom: { extra } } })).toBe(true);
  });

  it('validates string-valued maps without restricting their keys', () => {
    const maps = {
      env: { CUSTOM_ENV: 'value', OTHER_ENV: '' },
      extensionToLanguage: { '.custom': 'custom-language', arbitrary: '' },
    };

    expect(scoped.check({ ...requiredServer, ...maps })).toBe(true);
    expect(inputServer.check(maps)).toBe(true);
    expect(inputConfig.check({ servers: { arbitrary: maps } })).toBe(true);
  });

  it.each([
    { env: { CUSTOM_ENV: 1 } },
    { env: { CUSTOM_ENV: false } },
    { env: null },
    { extensionToLanguage: { '.ts': 1 } },
    { extensionToLanguage: { '.ts': null } },
    { extensionToLanguage: [] },
  ])('rejects invalid map values: %j', (invalid) => {
    expect(scoped.check({ ...requiredServer, ...invalid })).toBe(false);
    expect(inputServer.check(invalid)).toBe(false);
    expect(inputConfig.check({ servers: { custom: invalid } })).toBe(false);
  });

  it.each([{ entry: null }, { entry: false }, { entry: 'language-server' }, { entry: [] }])(
    'rejects non-object server entries: %j',
    ({ entry }) => {
      expect(inputConfig.check({ servers: { custom: entry } })).toBe(false);
    }
  );

  it.each([
    { command: 1 },
    { args: '--stdio' },
    { args: [1] },
    { enabled: 'false' },
    { startupTimeout: '1' },
    { shutdownTimeout: '1' },
    { restartOnCrash: 'true' },
    { maxRestarts: '1' },
    { workspaceFolder: 1 },
    { conflictGroup: false },
    { role: 'other' },
    { transport: 'other' },
  ])('rejects invalid known fields without coercion: %j', (invalid) => {
    const value = { ...requiredServer, ...invalid };
    const original = structuredClone(value);

    expect(scoped.check(value)).toBe(false);
    expect(inputServer.check(value)).toBe(false);
    expect(value).toEqual(original);
  });

  it('validates input extension arrays and the top-level servers map', () => {
    expect(inputServer.check({ extensions: '.ts' })).toBe(false);
    expect(inputServer.check({ extensions: [1] })).toBe(false);
    expect(inputConfig.check({ servers: 'custom' })).toBe(false);
    expect(inputConfig.check({ servers: [] })).toBe(false);
  });

  it.each([
    { options: null },
    { options: true },
    { options: 1 },
    { options: 'custom' },
    { options: [] },
    { options: { nested: [null, false, { value: 'custom' }] } },
  ])('preserves arbitrary JSON settings and initialization options: %j', ({ options }) => {
    const value = {
      ...requiredServer,
      settings: options,
      initializationOptions: options,
    };
    const original = structuredClone(value);

    expect(scoped.check(value)).toBe(true);
    expect(inputServer.check(value)).toBe(true);
    expect(inputConfig.check({ servers: { custom: value } })).toBe(true);
    expect(value).toEqual(original);
    expect(value.settings).toBe(options);
    expect(value.initializationOptions).toBe(options);
  });
});
