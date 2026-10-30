import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.each(['ignored', 'tracked'])('verifies %s review docs and rejects additional unrecorded source input', documentationState => {
  const root = mkdtempSync(path.join(tmpdir(), 'dcsc-release-verifier-'));
  const script = fileURLToPath(new URL('../scripts/release-checkpoint.ts', import.meta.url));
  const loader = createRequire(import.meta.url).resolve('tsx');
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', loader, script, ...args], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
  });
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    writeFileSync(path.join(root, '.gitignore'), 'artifacts/\n.docs/\n');
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: {} }));
    writeFileSync(path.join(root, 'package-lock.json'), '{}');
    mkdirSync(path.join(root, 'scripts'));
    // The manifest audits these maintained commands even with an empty npm catalog.
    for (const name of ['conformance.ts', 'verify-fixes.ts']) writeFileSync(path.join(root, 'scripts', name), '');
    git('add', '.');
    git('-c', 'user.name=Checkpoint Test', '-c', 'user.email=checkpoint@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture baseline');
    mkdirSync(path.join(root, '.docs/roadmaps'), { recursive: true });
    for (const name of ['parity', 'progress', 'finding_audit']) {
      writeFileSync(path.join(root, `.docs/roadmaps/2026_10_15_dcsc_${name}.md`), 'fixture');
    }
    if (documentationState === 'tracked') {
      git('add', '-f', '.docs');
      git('-c', 'user.name=Checkpoint Test', '-c', 'user.email=checkpoint@example.invalid',
        '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Track review docs');
      writeFileSync(path.join(root, '.docs/roadmaps/2026_10_15_dcsc_parity.md'), 'updated tracked review');
    }
    writeFileSync(path.join(root, 'existing-input.ts'), 'export const value = 1;');
    const manifest = path.join(root, 'artifacts/checkpoint/manifest.json');
    const prepared = run('--out', path.dirname(manifest));
    expect(prepared.status, prepared.stderr).toBe(0);
    const checkpoint = JSON.parse(readFileSync(manifest, 'utf8')) as {
      releaseCommands: Array<{ command: string; blockedExit?: number }>;
      repository: { ignoredDocumentation: { count: number } };
    };
    expect(checkpoint.repository.ignoredDocumentation.count).toBe(documentationState === 'ignored' ? 3 : 0);
    expect(checkpoint.releaseCommands.find(entry => entry.command === 'npm run parity:recovery'))
      .toMatchObject({ blockedExit: 2 });
    for (const command of ['npm run parity:manual-replace:breakout', 'npm run parity:manual-create:breakout']) {
      expect(checkpoint.releaseCommands.find(entry => entry.command === command)).toMatchObject({ blockedExit: 2 });
    }
    const verified = run('--verify', manifest);
    expect(verified.status, verified.stderr).toBe(0);
    const reviewFile = path.join(root, '.docs/roadmaps/2026_10_15_dcsc_parity.md');
    const reviewBefore = readFileSync(reviewFile);
    writeFileSync(reviewFile, 'unrecorded review change');
    expect(run('--verify', manifest).status).not.toBe(0);
    writeFileSync(reviewFile, reviewBefore);
    writeFileSync(path.join(root, 'unexpected-input.ts'), 'export const value = 2;');
    const rejected = run('--verify', manifest);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('untracked source path set differs');
    rmSync(path.join(root, 'unexpected-input.ts'));
    const restored = run('--verify', manifest);
    expect(restored.status, restored.stderr).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
