// ABOUTME: Shared types for the LSP extension.
// ABOUTME: Server lifecycle state, scoped server configuration, and tool result details.

/**
 * Lifecycle state of a single LSP server instance.
 */
export type LspServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

/**
 * Resolved configuration for a single LSP server.
 *
 * `extensionToLanguage` maps a file extension (e.g. ".ts") to an LSP languageId
 * (e.g. "typescript"); it is the single source of truth for both extension
 * routing and the `languageId` sent in `textDocument/didOpen`.
 */
/**
 * Transport for talking to an LSP server. Only stdio is implemented; socket is
 * accepted for config compatibility and ignored at runtime.
 */
export type LspTransport = 'stdio' | 'socket';

export interface ScopedLspServerConfig {
  command: string;
  args?: string[];
  extensionToLanguage: Record<string, string>;
  env?: Record<string, string>;
  initializationOptions?: unknown;
  /** Server settings pushed via workspace/didChangeConfiguration (optional). */
  settings?: unknown;
  workspaceFolder?: string;
  startupTimeout?: number;
  /** Graceful shutdown timeout in ms. Optional; defaults to no timeout. */
  shutdownTimeout?: number;
  /** Auto-restart the server when it crashes. Optional; defaults to false. */
  restartOnCrash?: boolean;
  maxRestarts?: number;
  /** Accepted for compatibility; only 'stdio' is implemented. */
  transport?: LspTransport;
}

/**
 * Structured details attached to an `lsp` tool result.
 */
export interface LspToolDetails {
  operation: string;
  filePath: string;
  resultCount?: number;
  fileCount?: number;
  truncated?: boolean;
  ready?: boolean;
}
