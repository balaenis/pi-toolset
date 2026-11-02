// ABOUTME: Shared types and native pi-schema configuration schemas for the LSP extension.
// ABOUTME: Server lifecycle state, open scoped server configuration, and tool result details.

import {
  arr,
  bool,
  lit,
  map,
  num,
  obj,
  opt,
  type Static,
  str,
  union,
  unknown as unknownSchema,
} from '@earendil-works/pi-schema';

export type LspServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export const LspTransportSchema = union([lit('stdio'), lit('socket')], {
  description:
    'Transport used to talk to the LSP server. Only "stdio" is implemented; "socket" is accepted for config compatibility and ignored at runtime.',
});
export type LspTransport = Static<typeof LspTransportSchema>;

export const LspServerRoleSchema = union([lit('primary'), lit('companion')], {
  description:
    'Role of the server in multi-server routing. "primary" servers provide language understanding (navigation, hover, symbols) and at most one is consulted per file for tool requests. "companion" servers augment the primary with extra diagnostics or contextual help (e.g. lint, Tailwind CSS) and do not participate in primary-only operations.',
});
export type LspServerRole = Static<typeof LspServerRoleSchema>;

const LspServerBaseProperties = {
  command: str({
    description: 'Executable used to launch the LSP server process.',
  }),
  args: opt(
    arr(str(), {
      description: 'Arguments passed to the server executable.',
    })
  ),
  extensionToLanguage: map(str(), {
    description:
      'Map from file extension (e.g. ".ts") to an LSP languageId (e.g. "typescript"). Single source of truth for both extension routing and the `languageId` sent in `textDocument/didOpen`.',
  }),
  role: opt(LspServerRoleSchema),
  startupTimeout: opt(
    num({
      description: 'Maximum time in milliseconds to wait for the server to finish initializing.',
    })
  ),
  settings: opt(
    unknownSchema({
      description: 'Server settings returned in response to `workspace/configuration` requests.',
    })
  ),
  enabled: opt(
    bool({
      description:
        'When false, the server is disabled and excluded from routing entirely. Defaults to true.',
    })
  ),
};

export const LspServerBaseSchema = obj(LspServerBaseProperties, { open: true });

export const LspServerRecipeSchema = obj(
  {
    ...LspServerBaseProperties,
    name: str({
      description: 'Name of the server.',
    }),
    installHint: str({
      description: 'Human-readable install hint shown when the command is not on PATH.',
    }),
  },
  { open: true }
);
export type LspServerRecipe = Static<typeof LspServerRecipeSchema>;

const ScopedLspServerConfigProperties = {
  ...LspServerBaseProperties,
  env: opt(
    map(str(), {
      description: 'Environment variables added to the spawned server process.',
    })
  ),
  initializationOptions: opt(
    unknownSchema({
      description: 'Value forwarded as `initializationOptions` in the LSP `initialize` request.',
    })
  ),
  workspaceFolder: opt(
    str({
      description:
        'Override the workspace root reported to the server. Defaults to the current working directory.',
    })
  ),
  shutdownTimeout: opt(
    num({
      description: 'Graceful shutdown timeout in milliseconds. Defaults to no timeout.',
    })
  ),
  restartOnCrash: opt(
    bool({
      description: 'Auto-restart the server when it crashes. Defaults to false.',
    })
  ),
  maxRestarts: opt(
    num({
      description: 'Maximum number of automatic restart attempts when `restartOnCrash` is enabled.',
    })
  ),
  transport: opt(LspTransportSchema),
  conflictGroup: opt(
    str({
      description:
        'Grouping key for primary replacement scenarios (e.g. two TS-like servers should not both fire). Defaults to the server name for primary servers and is undefined for companions.',
    })
  ),
};

export const ScopedLspServerConfigSchema = obj(ScopedLspServerConfigProperties, { open: true });

export type ScopedLspServerConfig = Static<typeof ScopedLspServerConfigSchema>;

export const InputScopedLspServerConfigSchema = obj(
  {
    ...ScopedLspServerConfigProperties,
    command: opt(
      str({
        description:
          'Executable used to launch the LSP server process. May be omitted when a user entry only tweaks or disables a built-in recipe by name; runtime validation catches non-recipe entries.',
      })
    ),
    extensionToLanguage: opt(
      map(str(), {
        description:
          'Map from file extension (e.g. ".ts") to an LSP languageId (e.g. "typescript"). Optional on input; merged with a built-in recipe when extending one.',
      })
    ),
    extensions: opt(
      arr(str(), {
        description:
          'Shorthand list of file extensions to attach the server to, using each extension as its own languageId. Merged with `extensionToLanguage` when both are present.',
      })
    ),
  },
  { open: true }
);

export type InputScopedLspServerConfig = Static<typeof InputScopedLspServerConfigSchema>;

export const InputLspConfigSchema = obj(
  {
    servers: opt(
      map(InputScopedLspServerConfigSchema, {
        description:
          'Map from server name to its input config. Names match built-in recipes to override or extend their defaults.',
      })
    ),
  },
  { open: true }
);

export type InputLspConfig = Static<typeof InputLspConfigSchema>;

export interface LspToolDetails {
  operation: string;
  filePath: string;
  resultCount?: number;
  fileCount?: number;
  truncated?: boolean;
  ready?: boolean;
}
