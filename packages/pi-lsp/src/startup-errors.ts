// ABOUTME: Classifies LSP startup failures into permanent blocks or bounded retries.
// ABOUTME: Carries structured startup metadata without changing the public client API.

export type StartupFailureKind =
  | 'permanent-path'
  | 'permanent-arguments'
  | 'permanent-configuration'
  | 'retryable-timeout'
  | 'retryable-unknown';

export interface StartupFailureClassification {
  retryable: boolean;
  kind: StartupFailureKind;
  reason: string;
}

export interface StartupErrorMetadata {
  spawnCode?: string;
  startupStderr?: string;
  phase?: 'start' | 'initialize' | 'connection' | 'exit';
}

type ErrorWithStartupMetadata = Error & {
  spawnCode?: string;
  startupStderr?: string;
  phase?: StartupErrorMetadata['phase'];
  code?: string;
};

const PATH_ERROR_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'ENAMETOOLONG']);
const PERMISSION_ERROR_CODES = new Set(['EACCES', 'EPERM', 'ENOEXEC']);

const ARGUMENT_PATTERNS = [
  /\bunknown option\b/i,
  /\bunrecognized option\b/i,
  /\binvalid option\b/i,
  /\billegal option\b/i,
  /\bbad option\b/i,
  /\bmissing required argument\b/i,
  /\boption requires an argument\b/i,
  /\brequires a value\b/i,
  /\bunknown command\b/i,
  /\binvalid command\b/i,
  /\bunsupported option\b/i,
];

const CONFIGURATION_PATTERNS = [
  /\binvalid initializationOptions\b/i,
  /\binvalid configuration\b/i,
  /\bunsupported transport\b/i,
  /\bfailed to parse config\b/i,
];

export function attachStartupErrorMetadata<T extends Error>(
  error: T,
  metadata: StartupErrorMetadata
): T {
  const target = error as ErrorWithStartupMetadata;
  if (metadata.spawnCode) target.spawnCode = metadata.spawnCode;
  if (metadata.startupStderr) target.startupStderr = metadata.startupStderr;
  if (metadata.phase) target.phase = metadata.phase;
  return error;
}

export function formatStartupError(error: unknown): string {
  const metadata = getStartupErrorMetadata(error);
  const message = messageOf(error);
  if (!metadata.startupStderr) return message;
  // Avoid printing the same stderr twice if an earlier layer already embedded it
  // in the error message (e.g. a crash exit message includes the stderr inline).
  if (message.includes(metadata.startupStderr)) return message;
  return `${message}\nServer stderr (last output):\n${metadata.startupStderr}`;
}

export function classifyStartupFailure(error: unknown): StartupFailureClassification {
  const metadata = getStartupErrorMetadata(error);
  const code = metadata.spawnCode;

  if (code && PATH_ERROR_CODES.has(code)) {
    return {
      retryable: false,
      kind: 'permanent-path',
      reason: `not retrying because the executable or workspace path failed with ${code}`,
    };
  }

  if (code && PERMISSION_ERROR_CODES.has(code)) {
    return {
      retryable: false,
      kind: 'permanent-path',
      reason: `not retrying because the executable cannot be run (${code})`,
    };
  }

  const text = [messageOf(error), metadata.startupStderr].filter(Boolean).join('\n');

  if (ARGUMENT_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      retryable: false,
      kind: 'permanent-arguments',
      reason: 'not retrying because startup output indicates invalid command-line arguments',
    };
  }

  if (CONFIGURATION_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      retryable: false,
      kind: 'permanent-configuration',
      reason: 'not retrying because startup output indicates invalid LSP configuration',
    };
  }

  if (/\btimed out\b/i.test(text) || /\btimeout\b/i.test(text)) {
    return {
      retryable: true,
      kind: 'retryable-timeout',
      reason: 'retrying because startup timed out',
    };
  }

  return {
    retryable: true,
    kind: 'retryable-unknown',
    reason: 'retrying because the startup failure was not recognized as permanent',
  };
}

export function getStartupErrorMetadata(error: unknown): StartupErrorMetadata {
  const err = error as Partial<ErrorWithStartupMetadata> | undefined;
  return {
    spawnCode: typeof err?.spawnCode === 'string' ? err.spawnCode : errorCode(error),
    startupStderr: typeof err?.startupStderr === 'string' ? err.startupStderr : undefined,
    phase: err?.phase,
  };
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '';
}
