import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config/load.js';

const helper = fileURLToPath(new URL('./helpers/persistence-child.ts', import.meta.url));
const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const scenarios = [
  'quantity',
  'configure',
  'controls',
  'import',
  'import-standalone-software',
  'import-standalone-service',
  'launch-new',
  'launch-join',
  'clone',
  'clone-racked',
  'copy-racked',
  'rack-lock',
  'add-rack',
  'pdu',
  'layout-auto-connect',
  'layout-unplace',
  'layout-remove',
  'layout-arrange',
  'layout-move',
  'layout-remove-rack-unplace',
  'layout-remove-rack-delete',
  'config-close',
  'role-preferences',
  'storage-definition',
  'storage-rename',
  'storage-remove',
  'topology-local',
  'topology-auto-connect',
  'floor-cabling',
  'undo-redo',
  'undo-only',
  'software-launch',
  'software-set-quantity',
  'software-remove',
  'software-refresh',
  'software-replace',
  'standalone-selection',
  'service-basket',
  'service-set-quantity',
  'service-set-product-quantity',
  'service-remove',
  'service-refresh',
  'service-replace',
  'reconciliation',
  'reconciliation-proposal',
  'validation-metadata',
  'standalone-close',
  'concurrent-workspaces',
] as const;

describe('acknowledged mutations survive immediate process death', () => {
  it.each(scenarios)('%s survives SIGKILL and a clean service restart', async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), `dcsc-subprocess-${scenario}-`));
    roots.push(root);
    const stateFile = join(root, 'state', 'sessions.json');
    const writer = child('mutate', scenario, stateFile);
    const writerExit = once(writer, 'exit');

    const ack = await waitForMessage(writer, 'ack');
    expect(ack).toMatchObject({ status: 'ack', scenario });
    expect(writer.kill('SIGKILL')).toBe(true);
    const [exitCode, signal] = (await writerExit) as [number | null, NodeJS.Signals | null];
    expect(exitCode).toBeNull();
    expect(signal).toBe('SIGKILL');

    const reader = child('verify', scenario, stateFile);
    const readerExit = once(reader, 'exit');
    const verified = await waitForMessage(reader, 'verified');
    expect(verified).toMatchObject({ status: 'verified', scenario });
    const [readerCode, readerSignal] = (await readerExit) as [number | null, NodeJS.Signals | null];
    expect(readerSignal).toBeNull();
    expect(readerCode).toBe(0);
  }, 20_000);
});

describe('persistence configuration precedence', () => {
  it('applies defaults, then file, then environment, then explicit overrides', () => {
    const root = mkdtempSync(join(tmpdir(), 'dcsc-config-precedence-'));
    roots.push(root);
    const configFile = join(root, 'config.json');
    writeFileSync(
      configFile,
      JSON.stringify({
        locale: { country: 'DE', geo: 'EMEA', language: 'de', currency: 'EUR' },
        files: { persistSessions: false, sessionFile: join(root, 'from-file.json') },
      }),
    );
    vi.stubEnv('DCSC_CONFIG', configFile);
    vi.stubEnv('DCSC_CURRENCY', 'USD');
    vi.stubEnv('DCSC_PERSIST_SESSIONS', 'true');
    vi.stubEnv('DCSC_SESSION_FILE', join(root, 'from-env.json'));

    const config = loadConfig({
      locale: { currency: 'GBP' },
      files: { sessionFile: join(root, 'from-override.json') },
    });

    expect(config.locale.currency).toBe('GBP');
    expect(config.files.persistSessions).toBe(true);
    expect(config.files.sessionFile).toBe(join(root, 'from-override.json'));
  });
});

function child(
  mode: 'mutate' | 'verify',
  scenario: (typeof scenarios)[number],
  stateFile: string,
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['--import', 'tsx', helper, mode, scenario, stateFile], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      // Ensure developer-machine defaults cannot redirect this isolated child.
      DCSC_CONFIG: join(stateFile, '..', 'does-not-exist.json'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function waitForMessage(
  process: ChildProcessWithoutNullStreams,
  status: 'ack' | 'verified',
): Promise<Record<string, unknown>> {
  let stdout = '';
  let stderr = '';
  process.stdout.setEncoding('utf8');
  process.stderr.setEncoding('utf8');
  process.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  process.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      process.kill('SIGKILL');
      reject(new Error(`Timed out waiting for ${status}. stdout=${stdout} stderr=${stderr}`));
    }, 10_000);
    const inspect = () => {
      for (const line of stdout.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.status === status) {
            clearTimeout(timeout);
            process.stdout.off('data', inspect);
            resolve(parsed);
            return;
          }
        } catch {
          // Logger output and partial lines are ignored until a complete message arrives.
        }
      }
    };
    process.stdout.on('data', inspect);
    process.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    process.once('exit', (code, signal) => {
      if (!stdout.split('\n').some((line) => {
        try {
          return (JSON.parse(line) as Record<string, unknown>).status === status;
        } catch {
          return false;
        }
      })) {
        clearTimeout(timeout);
        reject(new Error(
          `Child exited before ${status} (code=${String(code)}, signal=${String(signal)}). ` +
          `stdout=${stdout} stderr=${stderr}`,
        ));
      }
    });
  });
}
