import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Config } from '../../src/config/schema.js';

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lenovo-dcsc-script-'));
  process.once('exit', () => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Keep developer/live scripts away from the MCP server's persistent state. */
export function isolateRuntime(config: Config): Config {
  const root = temporaryRoot();
  return {
    ...config,
    files: {
      ...config.files,
      persistSessions: false,
      sessionFile: join(root, 'sessions.json'),
      artifactDir: join(root, 'artifacts'),
    },
  };
}

/** Environment for a spawned MCP server that cannot reach the user's state. */
export function isolatedChildEnv(
  extra: Record<string, string> = {},
  persistSessions = false,
): Record<string, string> {
  const root = temporaryRoot();
  const configFile = join(root, 'config.json');
  writeFileSync(
    configFile,
    JSON.stringify({
      files: {
        persistSessions,
        sessionFile: join(root, 'sessions.json'),
        artifactDir: join(root, 'artifacts'),
      },
    }),
  );
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return {
    ...inherited,
    DCSC_CONFIG: configFile,
    DCSC_ARTIFACT_DIR: join(root, 'artifacts'),
    XDG_STATE_HOME: join(root, 'state'),
    ...extra,
  };
}

export async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
