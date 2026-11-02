// ABOUTME: Regression tests for native pi-schema formatter configuration schemas.
// ABOUTME: Covers optional inputs, open objects, formatter maps, and validation without coercion.

import { describe, expect, it } from 'bun:test';
import { compile } from '@earendil-works/pi-schema';
import { InputFormatConfigSchema, InputFormatterConfigSchema } from '../src/types.ts';

const formatter = compile(InputFormatterConfigSchema);
const config = compile(InputFormatConfigSchema);

describe('format configuration schemas', () => {
  it('allows empty config and partial formatter overrides without inserting defaults', () => {
    const value = { formatters: { builtin: { disabled: true }, custom: {} } };
    const original = structuredClone(value);

    expect(formatter.check({})).toBe(true);
    expect(formatter.check({ disabled: true })).toBe(true);
    expect(formatter.check({ command: ['formatter', '$FILE'] })).toBe(true);
    expect(config.check({})).toBe(true);
    expect(config.check({ formatters: {} })).toBe(true);
    expect(config.check(value)).toBe(true);
    expect(value).toEqual(original);
  });

  it('accepts typed options and arbitrary formatter names', () => {
    const entry = {
      disabled: false,
      command: ['formatter', '$FILE'],
      extensions: ['.ts'],
      timeoutMs: 1,
    };

    expect(formatter.check(entry)).toBe(true);
    expect(
      config.check({ enabled: true, formatOnWrite: false, formatters: { custom: entry } })
    ).toBe(true);
  });

  it.each([{ entry: null }, { entry: false }, { entry: 'formatter' }, { entry: [] }])(
    'rejects non-object formatter entries: %j',
    ({ entry }) => {
      expect(formatter.check(entry)).toBe(false);
      expect(config.check({ formatters: { custom: entry } })).toBe(false);
    }
  );

  it.each([
    { disabled: 'false' },
    { command: 'formatter $FILE' },
    { command: [1] },
    { extensions: '.ts' },
    { extensions: [1] },
    { timeoutMs: '1' },
    { timeoutMs: null },
  ])('rejects invalid formatter fields without coercion: %j', (entry) => {
    const value = { formatters: { custom: entry } };
    const original = structuredClone(value);

    expect(formatter.check(entry)).toBe(false);
    expect(config.check(value)).toBe(false);
    expect(value).toEqual(original);
  });

  it.each([
    { enabled: 'false' },
    { formatOnWrite: 1 },
    { formatters: 'formatter' },
    { formatters: [] },
    { formatters: null },
  ])('rejects invalid top-level fields without coercion: %j', (value) => {
    const original = structuredClone(value);

    expect(config.check(value)).toBe(false);
    expect(value).toEqual(original);
  });

  it.each([
    { outputConfig: null },
    { outputConfig: true },
    { outputConfig: 1 },
    { outputConfig: 'custom' },
    { outputConfig: [] },
    { outputConfig: { nested: [null, false, { value: 'custom' }] } },
  ])('permits and preserves arbitrary JSON in unknown config fields: %j', ({ outputConfig }) => {
    const entry = { outputConfig };
    const value = { outputConfig, formatters: { custom: entry } };
    const original = structuredClone(value);

    expect(formatter.check(entry)).toBe(true);
    expect(config.check(value)).toBe(true);
    expect(value).toEqual(original);
    expect(value.outputConfig).toBe(outputConfig);
    expect(value.formatters.custom.outputConfig).toBe(outputConfig);
  });
});
