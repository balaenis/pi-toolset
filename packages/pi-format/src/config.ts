// ABOUTME: Format extension config loader and normalizer.
// ABOUTME: Loads global and project config, merges them, validates formatter entries.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Value } from 'typebox/value';
import { CONFIG_DIR_NAME, getAgentDir } from '@earendil-works/pi-coding-agent';
import { logDebug, logError } from './log.ts';
import { BUILTIN_FORMATTER_RECIPES } from './recipes.ts';
import { stripJsonc } from './utils.ts';
import {
  InputFormatterConfigSchema,
  type FormatterConfig,
  type InputFormatConfig,
  type InputFormatterConfig,
} from './types.ts';

const CONFIG_FILENAME = path.join('@balaenis', 'pi-format', 'config.json');
const DEFAULT_TIMEOUT_MS = 30_000;

/** Top-level boolean flags editable via `/format config`. */
export const CONFIG_FLAG_KEYS = ['enabled', 'formatOnWrite'] as const;
export type ConfigFlagKey = (typeof CONFIG_FLAG_KEYS)[number];

export type ConfigScope = 'global' | 'project';

export type ConfigurableSettingKind = 'flag' | 'formatter';

/** One row shown in the `/format config` SettingsList. */
export type ConfigurableSettingEntry = {
  id: string;
  label: string;
  description?: string;
  /** Display state: true means on (for formatters, `!disabled`). */
  enabled: boolean;
  kind: ConfigurableSettingKind;
};

const FLAG_DESCRIPTIONS: Record<ConfigFlagKey, string> = {
  enabled: 'Register LLM format tool and auto-format hook',
  formatOnWrite: 'Register automatic post-write/edit formatting hook',
};

/**
 * Read and parse a JSONC config file. Returns undefined when the file is
 * missing or cannot be parsed.
 */
async function readConfigFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const content = await readFile(filePath, { encoding: 'utf-8' });
    const stripped = stripJsonc(content);
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logDebug(`config: failed to read ${filePath}: ${(error as Error).message}`);
    }
    return undefined;
  }
}

/**
 * Normalize a file extension to lowercase. Requires a leading dot.
 */
export function normalizeExtension(ext: string): string | undefined {
  const trimmed = ext.trim();
  if (!trimmed.startsWith('.')) return undefined;
  return trimmed.toLowerCase();
}

/**
 * Validate and normalize a single raw formatter config entry. Returns
 * undefined when the entry is invalid; the caller logs and skips it.
 */
export function normalizeFormatterConfig(
  name: string,
  raw: InputFormatterConfig
): FormatterConfig | undefined {
  if (!Value.Check(InputFormatterConfigSchema, raw)) {
    const errors = Value.Errors(InputFormatterConfigSchema, raw);
    logError(
      new Error(
        `Formatter '${name}' config invalid: ${errors.map((error) => error.message).join('; ')}`
      )
    );
    return undefined;
  }

  if (raw.command !== undefined) {
    if (raw.command.length === 0) {
      logError(new Error(`Formatter '${name}' command array must not be empty`));
      return undefined;
    }
    if (!raw.command.some((arg) => arg.includes('$FILE'))) {
      logError(new Error(`Formatter '${name}' command must include a $FILE token`));
      return undefined;
    }
  }

  let extensions: string[] = [];
  if (raw.extensions !== undefined) {
    const normalized: string[] = [];
    for (const ext of raw.extensions) {
      const value = normalizeExtension(ext);
      if (!value) {
        logError(new Error(`Formatter '${name}' extension '${ext}' must start with a leading dot`));
        return undefined;
      }
      normalized.push(value);
    }
    if (normalized.length === 0) {
      logError(new Error(`Formatter '${name}' extensions array must not be empty`));
      return undefined;
    }
    extensions = normalized;
  }

  return {
    name,
    disabled: raw.disabled ?? false,
    command: raw.command ?? [],
    extensions,
    timeoutMs: raw.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    source: 'user',
  };
}

function extractFormatters(
  settings: Record<string, unknown> | undefined
): Record<string, InputFormatterConfig> {
  if (!settings) return {};
  const config = settings as InputFormatConfig;
  if (!config.formatters) return {};
  return config.formatters as Record<string, InputFormatterConfig>;
}

/**
 * Merge global and project formatter records. Project entries override global
 * entries by formatter name.
 */
function mergeFormatterRecords(
  global: Record<string, InputFormatterConfig>,
  project: Record<string, InputFormatterConfig>
): Record<string, InputFormatterConfig> {
  return { ...global, ...project };
}

/**
 * Load and normalize format configuration for the given working directory.
 */
export async function getFormatConfig(cwd: string): Promise<{
  enabled: boolean;
  formatOnWrite: boolean;
  formatters: Record<string, FormatterConfig>;
}> {
  const globalPath = path.join(getAgentDir(), CONFIG_FILENAME);
  const projectPath = path.join(cwd, CONFIG_DIR_NAME, CONFIG_FILENAME);

  const [globalSettings, projectSettings] = await Promise.all([
    readConfigFile(globalPath),
    readConfigFile(projectPath),
  ]);

  let enabled = true;
  let formatOnWrite = true;

  enabled = readBoolean(globalSettings, 'enabled', enabled);
  formatOnWrite = readBoolean(globalSettings, 'formatOnWrite', formatOnWrite);
  enabled = readBoolean(projectSettings, 'enabled', enabled);
  formatOnWrite = readBoolean(projectSettings, 'formatOnWrite', formatOnWrite);

  const rawFormatters = mergeFormatterRecords(
    extractFormatters(globalSettings),
    extractFormatters(projectSettings)
  );

  const formatters: Record<string, FormatterConfig> = {};
  for (const [name, raw] of Object.entries(rawFormatters)) {
    if (!name.trim()) {
      logError(new Error(`Formatter name must not be empty`));
      continue;
    }
    const normalized = normalizeFormatterConfig(name, raw);
    if (normalized) {
      formatters[name] = normalized;
    }
  }

  logDebug(
    `config: enabled=${enabled} formatOnWrite=${formatOnWrite} formatters=${Object.keys(formatters).join(', ')}`
  );

  return { enabled, formatOnWrite, formatters };
}

/** Default timeout used when a formatter does not specify one. */
export { DEFAULT_TIMEOUT_MS };

/** Resolve the config.json path for a scope. */
export function getConfigFilePath(scope: ConfigScope, cwd: string): string {
  if (scope === 'global') {
    return path.join(getAgentDir(), CONFIG_FILENAME);
  }
  return path.join(cwd, CONFIG_DIR_NAME, CONFIG_FILENAME);
}

/** Stable id for a top-level flag setting row. */
export function flagSettingId(key: ConfigFlagKey): string {
  return key;
}

/** Stable id for a per-formatter enabled row. */
export function formatterSettingId(name: string): string {
  return `formatter:${name}`;
}

/**
 * List settings for one config scope (flags + built-in/user formatters).
 * Values come only from that scope's file; missing keys use defaults.
 */
export async function listConfigurableSettings(
  scope: ConfigScope,
  cwd: string
): Promise<ConfigurableSettingEntry[]> {
  const settings = await readConfigFile(getConfigFilePath(scope, cwd));
  const userFormatters = extractFormatters(settings);
  const recipeNames = BUILTIN_FORMATTER_RECIPES.map((recipe) => recipe.name);
  const names = new Set<string>([...recipeNames, ...Object.keys(userFormatters)]);

  const entries: ConfigurableSettingEntry[] = CONFIG_FLAG_KEYS.map((key) => ({
    id: flagSettingId(key),
    label: key,
    description: FLAG_DESCRIPTIONS[key],
    enabled: readBoolean(settings, key, true),
    kind: 'flag',
  }));

  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const raw = userFormatters[name];
    const disabled = raw?.disabled ?? false;
    const isBuiltin = recipeNames.includes(name);
    const source = isBuiltin ? (raw ? 'override' : 'builtin') : 'user';
    const command = raw?.command?.join(' ');
    entries.push({
      id: formatterSettingId(name),
      label: `${name} (${source})`,
      description: command,
      enabled: !disabled,
      kind: 'formatter',
    });
  }

  return entries;
}

/**
 * Persist a toggle from `/format config`.
 * Flag ids are `enabled` / `formatOnWrite`; formatter ids are `formatter:<name>`.
 * Creates the config file when missing. JSONC comments are not preserved.
 */
export async function setSettingEnabled(
  scope: ConfigScope,
  cwd: string,
  id: string,
  enabled: boolean
): Promise<void> {
  if (isConfigFlagKey(id)) {
    await writeConfigFlag(scope, cwd, id, enabled);
    return;
  }

  const formatterName = parseFormatterSettingId(id);
  if (formatterName === undefined) {
    throw new Error(`Unknown config setting id: ${id}`);
  }

  // UI "enabled" maps to the stored `disabled` field (inverted).
  await writeFormatterDisabled(scope, cwd, formatterName, !enabled);
}

function isConfigFlagKey(value: string): value is ConfigFlagKey {
  return (CONFIG_FLAG_KEYS as readonly string[]).includes(value);
}

function parseFormatterSettingId(id: string): string | undefined {
  if (!id.startsWith('formatter:')) return undefined;
  const name = id.slice('formatter:'.length);
  return name.length > 0 ? name : undefined;
}

async function writeConfigFlag(
  scope: ConfigScope,
  cwd: string,
  key: ConfigFlagKey,
  value: boolean
): Promise<void> {
  const filePath = getConfigFilePath(scope, cwd);
  const existing = (await readConfigFile(filePath)) ?? {};
  const next = {
    ...existing,
    [key]: value,
  };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  logDebug(`config: wrote ${key}=${value} to ${filePath}`);
}

async function writeFormatterDisabled(
  scope: ConfigScope,
  cwd: string,
  name: string,
  disabled: boolean
): Promise<void> {
  const filePath = getConfigFilePath(scope, cwd);
  const existing = (await readConfigFile(filePath)) ?? {};
  const existingFormatters =
    existing.formatters &&
    typeof existing.formatters === 'object' &&
    !Array.isArray(existing.formatters)
      ? (existing.formatters as Record<string, unknown>)
      : {};

  const currentEntry =
    existingFormatters[name] &&
    typeof existingFormatters[name] === 'object' &&
    !Array.isArray(existingFormatters[name])
      ? (existingFormatters[name] as Record<string, unknown>)
      : {};

  const next = {
    ...existing,
    formatters: {
      ...existingFormatters,
      [name]: {
        ...currentEntry,
        disabled,
      },
    },
  };

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  logDebug(`config: wrote formatters.${name}.disabled=${disabled} to ${filePath}`);
}

function readBoolean(
  settings: Record<string, unknown> | undefined,
  key: string,
  fallback: boolean
): boolean {
  if (!settings) return fallback;
  const value = settings[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    logError(new Error(`config: '${key}' must be a boolean, got ${typeof value}`));
    return fallback;
  }
  return value;
}
