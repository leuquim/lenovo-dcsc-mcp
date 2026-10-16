import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const helper = fileURLToPath(new URL('./helpers/switch-provisioning-persistence-child.ts', import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('generated-switch transaction durability', () => {
  it('restores identity, placement, graph, export and history after immediate SIGKILL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dcsc-switch-provisioning-'));
    roots.push(root);
    const stateFile = join(root, 'sessions.json');
    const writer = child('mutate', stateFile);
    const writerExit = once(writer, 'exit');
    const acknowledged = await waitFor(writer, 'ack');
    expect(acknowledged).toMatchObject({ status: 'ack' });
    expect(acknowledged['generatedId']).toMatch(/^US__/);

    expect(writer.kill('SIGKILL')).toBe(true);
    const [exitCode, signal] = await writerExit as [number | null, NodeJS.Signals | null];
    expect(exitCode).toBeNull();
    expect(signal).toBe('SIGKILL');

    const reader = child('verify', stateFile);
    const readerExit = once(reader, 'exit');
    const verified = await waitFor(reader, 'verified');
    expect(verified).toMatchObject({
      status: 'verified',
      workspace: acknowledged['workspace'],
      generatedId: acknowledged['generatedId'],
    });
    const [readerCode, readerSignal] = await readerExit as [number | null, NodeJS.Signals | null];
    expect(readerSignal).toBeNull();
    expect(readerCode).toBe(0);
  }, 20_000);
});

function child(mode: 'mutate' | 'verify', stateFile: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['--import', 'tsx', helper, mode, stateFile], {
    cwd: process.cwd(),
    env: { ...process.env, DCSC_CONFIG: join(stateFile, '..', 'none.json') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function waitFor(
  process: ChildProcessWithoutNullStreams,
  status: 'ack' | 'verified',
): Promise<Record<string, unknown>> {
  let stdout = '';
  let stderr = '';
  process.stdout.setEncoding('utf8');
  process.stderr.setEncoding('utf8');
  process.stdout.on('data', (chunk: string) => { stdout += chunk; });
  process.stderr.on('data', (chunk: string) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      process.kill('SIGKILL');
      reject(new Error(`Timed out waiting for ${status}; stdout=${stdout}; stderr=${stderr}`));
    }, 10_000);
    const inspect = () => {
      for (const line of stdout.split('\n')) {
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          if (value['status'] === status) {
            clearTimeout(timeout);
            resolve(value);
            return;
          }
        } catch {
          // Ignore logger lines and incomplete output until the expected JSON arrives.
        }
      }
    };
    process.stdout.on('data', inspect);
    process.once('error', reject);
    process.once('exit', (code, signal) => {
      inspect();
      clearTimeout(timeout);
      reject(new Error(`Child exited before ${status}; code=${String(code)} signal=${String(signal)} stderr=${stderr}`));
    });
  });
}
