// ABOUTME: Generate the JSON Schema for the user LSP config file from src/types.ts.
// ABOUTME: Writes packages/pi-lsp/schemas/pi-lsp-config.json.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import prettier from 'prettier';

import { InputLspConfigSchema } from '../src/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'schemas');
mkdirSync(outDir, { recursive: true });

const name = 'pi-lsp-config';
const json = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: `https://raw.githubusercontent.com/balaenis/pi-toolset/main/packages/pi-lsp/schemas/${name}.json`,
  ...InputLspConfigSchema,
};
const file = resolve(outDir, `${name}.json`);
const formatted = await prettier.format(JSON.stringify(json), {
  parser: 'json',
  filepath: file,
});
writeFileSync(file, formatted);
process.stdout.write(`wrote ${file}\n`);
