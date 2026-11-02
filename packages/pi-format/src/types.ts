// ABOUTME: Shared types and native pi-schema configuration schemas for the Pi format extension.
// ABOUTME: Open input config, formatter recipes, registry results, and format outcomes.

import { arr, bool, map, num, obj, opt, type Static, str } from '@earendil-works/pi-schema';

/**
 * Raw formatter entry from user config. All fields are optional so the user can
 * disable a built-in or override only the pieces they care about.
 */
export const InputFormatterConfigSchema = obj(
  {
    disabled: opt(bool({ description: 'Disable this formatter.' })),
    command: opt(
      arr(str(), {
        description: 'Command and arguments. Must include a $FILE token.',
      })
    ),
    extensions: opt(
      arr(str(), {
        description: 'File extensions this formatter handles (must start with ".").',
      })
    ),
    timeoutMs: opt(num({ description: 'Per-file formatter timeout in milliseconds.' })),
  },
  { open: true }
);

export type InputFormatterConfig = Static<typeof InputFormatterConfigSchema>;

/** Raw extension config as written by the user. */
export const InputFormatConfigSchema = obj(
  {
    enabled: opt(bool({ description: 'Master switch for the format extension.' })),
    formatOnWrite: opt(
      bool({
        description: 'Format automatically after successful write/edit tool results.',
      })
    ),
    formatters: opt(
      map(InputFormatterConfigSchema, {
        description: 'Per-formatter overrides and custom formatters.',
      })
    ),
  },
  { open: true }
);

export type InputFormatConfig = Static<typeof InputFormatConfigSchema>;

/** Where a formatter definition came from. */
export type FormatterSource = 'builtin' | 'user';

/** Normalized, validated formatter configuration. */
export interface FormatterConfig {
  name: string;
  disabled: boolean;
  command: string[];
  extensions: string[];
  timeoutMs: number;
  source: FormatterSource;
}

/** Resolved command for a single formatter invocation. */
export interface ResolvedFormatterCommand {
  command: string[];
}

/** A built-in formatter recipe that resolves to a command only when available. */
export interface FormatterRecipe {
  name: string;
  extensions: string[];
  resolve(ctx: RecipeContext): Promise<ResolvedFormatterCommand | false>;
}

/** Context passed to recipe resolution. */
export interface RecipeContext {
  cwd: string;
  findExecutable: (name: string) => string | undefined;
  readPackageJson: (dir: string) => Promise<unknown>;
  findUp: (names: string[]) => Promise<string | undefined>;
}

/** Whether formatting was requested explicitly or triggered automatically. */
export type FormatMode = 'explicit' | 'automatic';

/** Outcome of formatting a single file. */
export interface FormatResult {
  filePath: string;
  formatterName: string;
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  formatted: boolean;
  mode: FormatMode;
}

/** Summary returned by the shared format service. */
export interface FormatSummary {
  formatted: FormatResult[];
  skipped: { filePath: string; reason: string }[];
  failed: { filePath: string; formatterName?: string; error: string }[];
  disabled: boolean;
}

/** Options passed to formatPaths. */
export interface FormatOptions {
  mode: FormatMode;
  formatter?: string;
}

/** Runtime context used by the service to invoke formatters. */
export interface FormatServiceContext {
  cwd: string;
  exec: (
    command: string,
    args: string[],
    options?: { timeout?: number; signal?: AbortSignal }
  ) => Promise<{
    stdout: string;
    stderr: string;
    code: number;
    killed: boolean;
  }>;
}

/** Error thrown when config validation fails for a single formatter entry. */
export class FormatterConfigError extends Error {
  constructor(
    public readonly formatterName: string,
    message: string
  ) {
    super(message);
    this.name = 'FormatterConfigError';
  }
}
