// ABOUTME: Registers the `lsp` tool (all 9 LSP operations) on Pi's registerTool API.
// ABOUTME: Ports Claude Code's LSPTool.call flow, including callHierarchy two-step and gitignore filtering.

import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StringEnum, Type } from '@earendil-works/pi-ai';
import type { Static } from '@earendil-works/pi-ai';
import { truncateTail } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  SymbolInformation,
} from 'vscode-languageserver-types';
import {
  formatDocumentSymbolResult,
  formatFindReferencesResult,
  formatGoToDefinitionResult,
  formatHoverResult,
  formatIncomingCallsResult,
  formatOutgoingCallsResult,
  formatPrepareCallHierarchyResult,
  formatWorkspaceSymbolResult,
} from './formatters.ts';
import { filterGitIgnoredLocations } from './gitignore.ts';
import { errorMessage, logError } from './log.ts';
import { getManager, isLspConnected, waitForInitialization } from './manager.ts';
import type { LspToolDetails } from './types.ts';

const MAX_LSP_FILE_SIZE_BYTES = 10_000_000;

const OPERATIONS = [
  'goToDefinition',
  'findReferences',
  'hover',
  'documentSymbol',
  'workspaceSymbol',
  'goToImplementation',
  'prepareCallHierarchy',
  'incomingCalls',
  'outgoingCalls',
] as const;

const PARAMETERS = Type.Object({
  operation: StringEnum([...OPERATIONS], {
    description: 'The LSP operation to perform.',
  }),
  filePath: Type.String({
    description: 'The absolute or relative path to the file.',
  }),
  line: Type.Integer({
    minimum: 1,
    description: 'The line number (1-based, as shown in editors).',
  }),
  character: Type.Integer({
    minimum: 1,
    description: 'The character offset (1-based, as shown in editors).',
  }),
});

type Params = Static<typeof PARAMETERS>;

const DESCRIPTION = `Query Language Server Protocol (LSP) servers for code intelligence.

Supported operations:
- goToDefinition: Find where a symbol is defined
- findReferences: Find all references to a symbol
- hover: Get hover information (type signature, documentation) for a symbol
- documentSymbol: Get all symbols (functions, classes, variables) in a document
- workspaceSymbol: Search for symbols across the selected server's workspace
- goToImplementation: Find implementations of an interface or abstract method
- prepareCallHierarchy: Get the call hierarchy item at a position
- incomingCalls: Find all functions/methods that call the function at a position (two-step)
- outgoingCalls: Find all functions/methods called by the function at a position (two-step)

All operations require:
- filePath, line, character (1-based)

For documentSymbol and workspaceSymbol, line/character are accepted for Claude Code
compatibility but are not sent to the underlying LSP request. workspaceSymbol uses
filePath to select and initialize the matching LSP server, then sends an empty
workspace/symbol query to list symbols the server knows about.

An LSP server must be configured for the file type. If no server is available, a
message is returned instead of results. Results from location-returning operations
(findReferences, goToDefinition, goToImplementation, workspaceSymbol) are filtered to
exclude .gitignore'd files.`;

export function registerLspTool(pi: ExtensionAPI): void {
  pi.registerTool<typeof PARAMETERS, LspToolDetails>({
    name: 'lsp',
    label: 'LSP',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return runLsp(params, ctx.cwd);
    },
  });
}

async function runLsp(params: Params, cwd: string): Promise<AgentToolResult<LspToolDetails>> {
  // Wait for any in-flight initialization, then verify a server is connected.
  await waitForInitialization();
  if (!isLspConnected()) {
    return textResult(
      'LSP server is not ready. It may still be starting, or no server is configured for this file type.',
      params,
      { ready: false }
    );
  }

  const manager = getManager();
  if (!manager) {
    return textResult('LSP server manager is not initialized.', params);
  }

  const absolutePath = path.resolve(cwd, params.filePath);

  // SECURITY: skip filesystem stat for UNC paths to avoid NTLM credential leaks.
  const isUnc = absolutePath.startsWith('\\\\') || absolutePath.startsWith('//');

  if (!isUnc) {
    let stats;
    try {
      stats = await stat(absolutePath);
    } catch (error) {
      if (isENOENT(error)) {
        return textResult(`File does not exist: ${params.filePath}`, params);
      }
      return textResult(`Cannot access file: ${params.filePath}. ${errorMessage(error)}`, params);
    }
    if (!stats.isFile()) {
      return textResult(`Path is not a file: ${params.filePath}`, params);
    }
    if (stats.size > MAX_LSP_FILE_SIZE_BYTES) {
      return textResult(
        `File too large for LSP analysis (${Math.ceil(stats.size / 1_000_000)}MB exceeds 10MB limit)`,
        params
      );
    }
  }

  try {
    // Ensure the file is open in the LSP server before making requests.
    // Most servers require textDocument/didOpen before operations.
    if (!manager.isFileOpen(absolutePath)) {
      const content = await readFile(absolutePath, { encoding: 'utf-8' });
      await manager.openFile(absolutePath, content);
    }

    const { method, params: lspParams } = getMethodAndParams(params, absolutePath);

    let result = await manager.sendRequest(absolutePath, method, lspParams);
    if (result === undefined) {
      return textResult(
        `No LSP server available for file type: ${path.extname(absolutePath)}`,
        params
      );
    }

    // callHierarchy two-step: incoming/outgoing need the prepareCallHierarchy
    // item first, then a second request with that item.
    if (params.operation === 'incomingCalls' || params.operation === 'outgoingCalls') {
      const callItems = (result as CallHierarchyItem[]) ?? [];
      if (callItems.length === 0) {
        return withFormatted(
          params,
          params.operation === 'incomingCalls'
            ? 'No call hierarchy item found at this position'
            : 'No call hierarchy item found at this position',
          0,
          0
        );
      }
      const callMethod =
        params.operation === 'incomingCalls'
          ? 'callHierarchy/incomingCalls'
          : 'callHierarchy/outgoingCalls';
      result = await manager.sendRequest(absolutePath, callMethod, { item: callItems[0] });
    }

    // Filter gitignored files from location-returning operations.
    if (
      result &&
      Array.isArray(result) &&
      (params.operation === 'findReferences' ||
        params.operation === 'goToDefinition' ||
        params.operation === 'goToImplementation' ||
        params.operation === 'workspaceSymbol')
    ) {
      result = await applyGitignoreFilter(params.operation, result, cwd);
    }

    const { formatted, resultCount, fileCount } = formatResult(params.operation, result, cwd);

    return withFormatted(params, formatted, resultCount, fileCount);
  } catch (error) {
    logError(
      new Error(
        `LSP tool request failed for ${params.operation} on ${params.filePath}: ${errorMessage(error)}`
      )
    );
    return textResult(`Error performing ${params.operation}: ${errorMessage(error)}`, params);
  }
}

/**
 * Apply gitignore filtering to a location- or symbol-bearing result.
 * Mutates the array to drop ignored entries and returns it (typed as unknown
 * for the caller to feed back into formatResult).
 */
async function applyGitignoreFilter(
  operation: Params['operation'],
  result: unknown,
  cwd: string
): Promise<unknown> {
  if (operation === 'workspaceSymbol') {
    const symbols = (result as SymbolInformation[]) ?? [];
    const locations: Location[] = symbols.filter((s) => s?.location?.uri).map((s) => s.location);
    const filteredLocations = await filterGitIgnoredLocations(locations, cwd);
    const filteredUris = new Set(filteredLocations.map((l) => l.uri));
    return symbols.filter((s) => !s?.location?.uri || filteredUris.has(s.location.uri));
  }

  const items = (result as (Location | LocationLink)[]) ?? [];
  const locations = items.map(toLocation);
  const filteredLocations = await filterGitIgnoredLocations(locations, cwd);
  const filteredUris = new Set(filteredLocations.map((l) => l.uri));
  return items.filter((item) => {
    const loc = toLocation(item);
    return !loc.uri || filteredUris.has(loc.uri);
  });
}

/**
 * Maps an operation to its LSP method and params, converting the 1-based
 * editor position to the 0-based LSP protocol position.
 */
function getMethodAndParams(
  params: Params,
  absolutePath: string
): { method: string; params: unknown } {
  const uri = pathToFileURL(absolutePath).href;
  const position = {
    line: params.line - 1,
    character: params.character - 1,
  };

  switch (params.operation) {
    case 'findReferences':
      return {
        method: 'textDocument/references',
        params: { textDocument: { uri }, position, context: { includeDeclaration: true } },
      };
    case 'hover':
      return { method: 'textDocument/hover', params: { textDocument: { uri }, position } };
    case 'documentSymbol':
      return { method: 'textDocument/documentSymbol', params: { textDocument: { uri } } };
    case 'workspaceSymbol':
      return { method: 'workspace/symbol', params: { query: '' } };
    case 'goToImplementation':
      return { method: 'textDocument/implementation', params: { textDocument: { uri }, position } };
    case 'prepareCallHierarchy':
    case 'incomingCalls':
    case 'outgoingCalls':
      // incoming/outgoing both start with prepareCallHierarchy; the second step
      // happens in runLsp once we have the CallHierarchyItem.
      return {
        method: 'textDocument/prepareCallHierarchy',
        params: { textDocument: { uri }, position },
      };
    case 'goToDefinition':
    default:
      return { method: 'textDocument/definition', params: { textDocument: { uri }, position } };
  }
}

/**
 * Formats an LSP result and extracts summary counts.
 */
function formatResult(
  operation: Params['operation'],
  result: unknown,
  cwd: string
): { formatted: string; resultCount: number; fileCount: number } {
  switch (operation) {
    case 'findReferences': {
      const locations = (result as Location[]) ?? [];
      const valid = locations.filter((loc) => loc && loc.uri);
      return {
        formatted: formatFindReferencesResult(result as Location[] | null, cwd),
        resultCount: valid.length,
        fileCount: countUniqueFiles(valid),
      };
    }
    case 'hover':
      return {
        formatted: formatHoverResult(result as Hover | null, cwd),
        resultCount: result ? 1 : 0,
        fileCount: result ? 1 : 0,
      };
    case 'documentSymbol': {
      const symbols = (result as (DocumentSymbol | SymbolInformation)[]) ?? [];
      const isDocumentSymbol = symbols.length > 0 && 'range' in (symbols[0] ?? {});
      const count = isDocumentSymbol ? countSymbols(symbols as DocumentSymbol[]) : symbols.length;
      return {
        formatted: formatDocumentSymbolResult(
          result as DocumentSymbol[] | SymbolInformation[] | null,
          cwd
        ),
        resultCount: count,
        fileCount: symbols.length > 0 ? 1 : 0,
      };
    }
    case 'workspaceSymbol': {
      const symbols = (result as SymbolInformation[]) ?? [];
      const valid = symbols.filter((sym) => sym && sym.location && sym.location.uri);
      return {
        formatted: formatWorkspaceSymbolResult(result as SymbolInformation[] | null, cwd),
        resultCount: valid.length,
        fileCount: countUniqueFiles(valid.map((s) => s.location)),
      };
    }
    case 'goToImplementation':
    case 'goToDefinition': {
      const rawResults = Array.isArray(result)
        ? result
        : result
          ? [result as Location | LocationLink]
          : [];
      const locations = rawResults.map(toLocation);
      const valid = locations.filter((loc) => loc && loc.uri);
      return {
        formatted: formatGoToDefinitionResult(
          result as Location | Location[] | LocationLink | LocationLink[] | null,
          cwd
        ),
        resultCount: valid.length,
        fileCount: countUniqueFiles(valid),
      };
    }
    case 'prepareCallHierarchy': {
      const items = (result as CallHierarchyItem[]) ?? [];
      return {
        formatted: formatPrepareCallHierarchyResult(result as CallHierarchyItem[] | null, cwd),
        resultCount: items.length,
        fileCount:
          items.length > 0
            ? countUniqueFiles(items.map((i) => ({ uri: i.uri, range: i.range })))
            : 0,
      };
    }
    case 'incomingCalls': {
      const calls = (result as CallHierarchyIncomingCall[]) ?? [];
      const validUris = calls.map((c) => c.from?.uri).filter((u): u is string => !!u);
      return {
        formatted: formatIncomingCallsResult(result as CallHierarchyIncomingCall[] | null, cwd),
        resultCount: calls.length,
        fileCount: new Set(validUris).size,
      };
    }
    case 'outgoingCalls': {
      const calls = (result as CallHierarchyOutgoingCall[]) ?? [];
      const validUris = calls.map((c) => c.to?.uri).filter((u): u is string => !!u);
      return {
        formatted: formatOutgoingCallsResult(result as CallHierarchyOutgoingCall[] | null, cwd),
        resultCount: calls.length,
        fileCount: new Set(validUris).size,
      };
    }
  }
}

function isLocationLink(item: Location | LocationLink): item is LocationLink {
  return 'targetUri' in item;
}

function toLocation(item: Location | LocationLink): Location {
  if (isLocationLink(item)) {
    return { uri: item.targetUri, range: item.targetSelectionRange || item.targetRange };
  }
  return item;
}

function countUniqueFiles(locations: Location[]): number {
  return new Set(locations.map((loc) => loc.uri)).size;
}

/** Recursively count DocumentSymbol nodes including nested children. */
function countSymbols(symbols: DocumentSymbol[]): number {
  let count = symbols.length;
  for (const symbol of symbols) {
    if (symbol.children && symbol.children.length > 0) {
      count += countSymbols(symbol.children);
    }
  }
  return count;
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function textResult(
  text: string,
  params: Params,
  extra?: Partial<LspToolDetails>
): AgentToolResult<LspToolDetails> {
  return {
    content: [{ type: 'text', text }],
    details: { operation: params.operation, filePath: params.filePath, ...extra },
  };
}

/** Wrap a formatted result string with truncation and standard details. */
function withFormatted(
  params: Params,
  formatted: string,
  resultCount: number,
  fileCount: number
): AgentToolResult<LspToolDetails> {
  const truncation = truncateTail(formatted);
  const text = truncation.truncated
    ? `${truncation.content}\n\n[Output truncated]`
    : truncation.content;
  return {
    content: [{ type: 'text', text }],
    details: {
      operation: params.operation,
      filePath: params.filePath,
      resultCount,
      fileCount,
      truncated: truncation.truncated,
    },
  };
}
