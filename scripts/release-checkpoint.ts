/**
 * Prepares or verifies the source manifest used for an isolated release run.
 *
 * This script does not execute release gates and does not claim release
 * readiness. It captures the exact dirty patch, untracked source inputs and
 * explicitly ignored review docs so another worktree can reproduce them.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

interface FileDigest {
  path: string;
  bytes: number;
  sha256: string;
  kind: 'file' | 'symlink';
  mode: string;
  linkTarget?: string;
  gitState: 'tracked' | 'untracked' | 'ignored';
}

interface FileCollection {
  listFile: string;
  listBytes: number;
  listSha256: string;
  count: number;
  treeSha256: string;
  files: FileDigest[];
}

interface Manifest {
  schemaVersion: 2;
  phase: 'preflight';
  releaseReady: false;
  generatedAt: string;
  repository: {
    head: string;
    branch: string;
    trackedPatch: { file: string; bytes: number; sha256: string };
    untrackedInputs: FileCollection;
    ignoredDocumentation: FileCollection;
    packageLockSha256: string;
  };
  runtime: { node: string; npm: string };
  fixtureAudit: {
    dependencies: FileDigest[];
    ignoredRuntimeInputs: string[];
    missingRuntimeInputs: string[];
  };
  pendingGates: string[];
  releaseCommands: Array<{ command: string; class: 'local' | 'live' | 'headless'; blockedExit?: number }>;
  materializeSteps: string[];
}

const REVIEW_DOCS = [
  '.docs/roadmaps/2026_10_15_dcsc_parity.md',
  '.docs/roadmaps/2026_10_15_dcsc_progress.md',
  '.docs/roadmaps/2026_10_15_dcsc_finding_audit.md',
];

const RELEASE_COMMANDS: Manifest['releaseCommands'] = [
  { command: 'npm run typecheck', class: 'local' },
  { command: 'npm run lint', class: 'local' },
  { command: 'npm test', class: 'local' },
  { command: 'npm run contract', class: 'local' },
  { command: 'npm run build', class: 'local' },
  { command: 'npm audit --audit-level=moderate', class: 'live' },
  { command: 'npx tsx scripts/smoke.ts', class: 'live' },
  { command: 'npx tsx scripts/export-smoke.ts', class: 'live' },
  { command: 'npx tsx scripts/mcp-smoke.ts', class: 'live' },
  { command: 'npm run parity:offline', class: 'local' },
  { command: 'npm run contract:live -- all', class: 'live' },
  { command: 'npx tsx scripts/conformance.ts', class: 'live' },
  { command: 'npx tsx scripts/verify-fixes.ts', class: 'live', blockedExit: 2 },
  { command: 'npm run parity -- software-embedded', class: 'headless' },
  { command: 'npm run parity -- software-export', class: 'headless' },
  { command: 'npm run parity -- software-mixed', class: 'headless' },
  { command: 'npm run parity -- software-lfo', class: 'headless' },
  { command: 'npm run parity -- services', class: 'headless' },
  { command: 'npm run parity -- services-quantity', class: 'headless' },
  { command: 'npm run parity -- services-downloads', class: 'headless' },
  { command: 'npm run parity:lfo-as-cto', class: 'headless' },
  { command: 'npm run parity -- controls-locale', class: 'headless' },
  { command: 'npm run parity:network', class: 'headless' },
  { command: 'npm run parity:network-leaf', class: 'headless' },
  { command: 'npm run parity:storage -- --out artifacts/release/storage', class: 'live' },
  { command: 'npm run parity:storage-placement -- --out artifacts/release/storage-placement', class: 'live' },
  { command: 'npm run parity:storage-fc -- --out artifacts/release/storage-fc', class: 'headless', blockedExit: 2 },
  { command: 'npm run parity:manual-cabling', class: 'live' },
  { command: 'npm run parity:manual-create', class: 'headless' },
  { command: 'npm run parity:manual-replace:breakout', class: 'headless', blockedExit: 2 },
  { command: 'npm run parity:manual-create:breakout', class: 'headless', blockedExit: 2 },
  { command: 'npm run parity:manual-create:100g', class: 'headless' },
  { command: 'npm run parity:manual-create:managed-source', class: 'headless' },
  { command: 'npm run parity:manual-create:managed-destination', class: 'headless' },
  { command: 'npm run parity:manual-create:storage-prepare', class: 'headless' },
  { command: 'npm run parity:manual-create:fresh-storage', class: 'headless' },
  { command: 'npm run parity:manual-create:shared-storage', class: 'headless' },
  { command: 'npm run parity:manual-create:mixed-storage', class: 'headless' },
  { command: 'npm run parity:manual-replace:shared-storage', class: 'headless' },
  { command: 'npm run parity:manual-create:linked-source', class: 'headless' },
  { command: 'npm run parity:manual-create:linked-destination', class: 'headless' },
  { command: 'npm run parity:manual-cabling -- --cable-part AVFU', class: 'live' },
  { command: 'npm run parity:manual-cabling:shared', class: 'live' },
  { command: 'npm run parity:manual-cabling:collision', class: 'live' },
  { command: 'npm run parity:storage-reimport -- --mcp-report artifacts/release/storage/report.json', class: 'headless' },
  { command: 'npm run parity:storage-placement-reimport -- --mcp-report artifacts/release/storage-placement/report.json --out artifacts/release/storage-placement/reimport', class: 'headless' },
  { command: 'npm run parity:rack-power', class: 'headless' },
  { command: 'npm run parity -- power-controls', class: 'headless' },
  { command: 'npm run parity:pci-wizard', class: 'headless' },
  { command: 'npm run parity:pci-wizard -- --linked', class: 'headless' },
  { command: 'npm run parity:storage-wizard', class: 'headless' },
  { command: 'npm run parity:storage-wizard -- --clear', class: 'headless' },
  { command: 'npm run parity:storage-wizard -- --raid', class: 'headless' },
  { command: 'npm run parity:storage-wizard -- --raid-reverse', class: 'headless' },
  { command: 'npm run parity:storage-wizard -- --sr850', class: 'headless' },
  { command: 'npm run parity:manual-source-swap', class: 'headless' },
  { command: 'npm run parity -- workbook-import', class: 'headless' },
  { command: 'npm run parity:chassis-clone', class: 'headless' },
  { command: 'npm run parity:chassis-parent-edit', class: 'headless' },
  { command: 'npm run parity:chassis-linked-copy', class: 'headless' },
  { command: 'npm run parity:chassis-member-copy', class: 'headless' },
  { command: 'npm run parity:chassis-copy', class: 'headless' },
  { command: 'npm run parity:nested-grouped-import', class: 'headless' },
  { command: 'npm run parity:grouped-rack-import', class: 'headless' },
  { command: 'npm run parity -- xconfig-import', class: 'headless' },
  { command: 'npm run parity -- reference-solutions', class: 'headless' },
  { command: 'npm run parity -- reference-download', class: 'headless' },
  { command: 'npm run parity -- reference-unconfigured', class: 'headless' },
  { command: 'npm run parity:rack-power -- --multi', class: 'headless' },
  { command: 'npm run parity:rack-lock', class: 'headless' },
  { command: 'npm run parity:rack-lock -- --mcp', class: 'headless' },
  { command: 'npm run parity:rack-lifecycle', class: 'headless' },
  { command: 'npm run parity:rack-multiu', class: 'headless' },
  { command: 'npm run parity:rack-clone', class: 'headless' },
  { command: 'npm run parity:switch-clone', class: 'headless' },
  { command: 'npm run parity:switch-edit', class: 'headless' },
  { command: 'npm run parity:rack-clone -- --action=clone --fresh', class: 'headless' },
  { command: 'npm run parity:rack-clone -- --mcp --copy', class: 'headless' },
  { command: 'npm run parity:rack-clone -- --mcp --linked-edit=source', class: 'headless' },
  { command: 'npm run parity:rack-clone -- --mcp --linked-edit=member', class: 'headless' },
  { command: 'npm run parity:rack-clone -- --mcp --clones=2 --delete=root', class: 'headless' },
  { command: 'npm run parity:nested-vlh', class: 'headless' },
  { command: 'npm run parity:nested-stdio', class: 'live' },
  { command: 'npm run parity:nested-remove-chassis -- --out=artifacts/release/nested-remove-chassis', class: 'headless' },
  { command: 'npm run parity:nested-detach -- --out=artifacts/release/nested-detach', class: 'headless' },
  { command: 'npm run parity:nested-unplace -- --out=artifacts/release/nested-unplace', class: 'headless' },
  { command: 'npm run parity:recovery', class: 'live', blockedExit: 2 },
  { command: 'npm run parity -- projections', class: 'live' },
  { command: 'npm run parity -- catalogs', class: 'live' },
  { command: 'npm run parity -- export-types', class: 'headless' },
  { command: 'npm run parity -- software-search', class: 'headless' },
  { command: 'npm run parity -- validation', class: 'live', blockedExit: 2 },
  { command: 'npm run parity:headless', class: 'headless', blockedExit: 2 },
];

function git(args: string[], encoding: BufferEncoding = 'utf8'): string {
  return execFileSync('git', args, { cwd: process.cwd(), encoding });
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function digestFile(relative: string): FileDigest {
  const absolute = path.resolve(relative);
  const info = lstatSync(absolute);
  assert(info.isFile() || info.isSymbolicLink(), `${relative} must be a regular file or symbolic link.`);
  const linkTarget = info.isSymbolicLink() ? readlinkSync(absolute) : undefined;
  const bytes = linkTarget === undefined ? readFileSync(absolute) : Buffer.from(linkTarget);
  return {
    path: relative,
    bytes: bytes.length,
    sha256: sha256(bytes),
    kind: info.isSymbolicLink() ? 'symlink' : 'file',
    mode: (info.mode & 0o777).toString(8).padStart(3, '0'),
    ...(linkTarget === undefined ? {} : { linkTarget }),
    gitState: gitState(relative),
  };
}

function gitState(relative: string): FileDigest['gitState'] {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', relative], {
      cwd: process.cwd(), stdio: 'ignore',
    });
    return 'tracked';
  } catch { /* Continue. */ }
  try {
    execFileSync('git', ['check-ignore', '-q', '--', relative], {
      cwd: process.cwd(), stdio: 'ignore',
    });
    return 'ignored';
  } catch { return 'untracked'; }
}

function nulGitFiles(args: string[]): string[] {
  const value = execFileSync('git', [...args, '-z'], { cwd: process.cwd() });
  return value.toString('utf8').split('\0').filter(Boolean).sort();
}

function treeSha256(files: FileDigest[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.path).update('\0')
      .update(file.sha256).update('\0')
      .update(String(file.bytes)).update('\0')
      .update(file.kind).update('\0')
      .update(file.mode).update('\0')
      .update(file.linkTarget ?? '').update('\0')
      .update(file.gitState).update('\0');
  }
  return hash.digest('hex');
}

function nulPathList(paths: string[]): Buffer {
  return Buffer.from(paths.length === 0 ? '' : `${paths.join('\0')}\0`);
}

function collection(listFile: string, paths: string[], files: FileDigest[]): FileCollection {
  const list = nulPathList(paths);
  return {
    listFile,
    listBytes: list.length,
    listSha256: sha256(list),
    count: files.length,
    treeSha256: treeSha256(files),
    files,
  };
}

function literalFixtureDependencies(): string[] {
  const candidates = [
    ...nulGitFiles(['ls-files', 'scripts', 'test']),
    ...nulGitFiles(['ls-files', '--others', '--exclude-standard', 'scripts', 'test']),
  ].filter(file => /\.(?:ts|js|mjs)$/.test(file));
  const dependencies = new Set<string>();
  const pattern = /["']((?:test\/fixtures|scripts\/fixtures|fixtures)\/[^"']+)["']/g;
  for (const source of candidates) {
    const text = readFileSync(source, 'utf8');
    for (const match of text.matchAll(pattern)) {
      const dependency = match[1];
      if (dependency && !dependency.includes('${') && !dependency.includes('*')) dependencies.add(dependency);
    }
  }
  // Include all repository test fixtures. Several tests enumerate or construct
  // paths dynamically, which cannot be found safely with a literal scan.
  for (const fixture of [
    ...nulGitFiles(['ls-files', 'test/fixtures']),
    ...nulGitFiles(['ls-files', '--others', '--exclude-standard', 'test/fixtures']),
  ]) dependencies.add(fixture);
  return [...dependencies].sort();
}

function ignoredArtifactInputsInReleaseScripts(): string[] {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const scriptFiles = new Set<string>(['scripts/conformance.ts', 'scripts/verify-fixes.ts']);
  for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
    if (!name.startsWith('parity:') && name !== 'contract:live') continue;
    const match = /scripts\/[\w./-]+\.(?:ts|js|mjs)/.exec(command);
    if (match) scriptFiles.add(match[0]);
  }
  const inputs = new Set<string>();
  const inputConstant = /(?:SEED|FIXTURE|CONTRACT|SOURCE|ORACLE)[\s\S]{0,160}?["'](artifacts\/[^"']+)["']/g;
  const directRead = /readFile(?:Sync)?\([^)]{0,120}?["'](artifacts\/[^"']+)["']/g;
  for (const script of scriptFiles) {
    const text = readFileSync(script, 'utf8');
    for (const pattern of [inputConstant, directRead]) {
      for (const match of text.matchAll(pattern)) if (match[1]) inputs.add(`${script}: ${match[1]}`);
    }
  }
  return [...inputs].sort();
}

function prepare(outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  const patch = execFileSync('git', ['diff', '--binary', '--full-index', '--no-ext-diff', 'HEAD', '--'], {
    cwd: process.cwd(),
  });
  const untrackedPaths = nulGitFiles(['ls-files', '--others', '--exclude-standard']);
  const untracked = untrackedPaths.map(digestFile);
  // Tracked and ordinary untracked docs already travel with the patch/input list.
  // Only ignored review docs need an explicit supplemental collection.
  const docs = REVIEW_DOCS.map(digestFile).filter(file => file.gitState === 'ignored');
  const ignoredDocPaths = docs.map(file => file.path);
  const fixturePaths = literalFixtureDependencies();
  const missingRuntimeInputs = fixturePaths.filter(relative => {
    try { statSync(relative); return false; } catch { return true; }
  });
  const dependencies = fixturePaths.filter(relative => !missingRuntimeInputs.includes(relative)).map(digestFile);
  const ignoredRuntimeInputs = dependencies.filter(file => file.gitState === 'ignored').map(file => file.path);
  ignoredRuntimeInputs.push(...ignoredArtifactInputsInReleaseScripts());

  const untrackedList = nulPathList(untrackedPaths);
  const docsList = nulPathList(ignoredDocPaths);
  writeFileSync(path.join(outDir, 'tracked.patch'), patch);
  writeFileSync(path.join(outDir, 'untracked-inputs.nul'), untrackedList);
  writeFileSync(path.join(outDir, 'ignored-doc-inputs.nul'), docsList);

  // A porcelain status string does not change when an already-modified file is
  // edited. Re-capture content, paths, types and modes so a moving worktree can
  // never produce a manifest assembled from different source revisions.
  const finalPatch = execFileSync('git', ['diff', '--binary', '--full-index', '--no-ext-diff', 'HEAD', '--'], {
    cwd: process.cwd(),
  });
  const finalUntrackedPaths = nulGitFiles(['ls-files', '--others', '--exclude-standard']);
  const finalUntracked = finalUntrackedPaths.map(digestFile);
  const finalDocs = ignoredDocPaths.map(digestFile);
  assert.equal(sha256(finalPatch), sha256(patch),
    'Tracked content changed while the preflight manifest was generated. Run it again after active edits settle.');
  assert.deepEqual(finalUntrackedPaths, untrackedPaths,
    'The untracked path set changed while the preflight manifest was generated.');
  assert.equal(treeSha256(finalUntracked), treeSha256(untracked),
    'Untracked content, type or mode changed while the preflight manifest was generated.');
  assert.equal(treeSha256(finalDocs), treeSha256(docs),
    'Ignored review documentation changed while the preflight manifest was generated.');
  assert.equal(missingRuntimeInputs.length, 0,
    `Missing runtime inputs: ${missingRuntimeInputs.join(', ')}`);
  assert.equal(ignoredRuntimeInputs.length, 0,
    `Maintained release commands still depend on ignored runtime inputs: ${ignoredRuntimeInputs.join(', ')}`);

  const manifest: Manifest = {
    schemaVersion: 2,
    phase: 'preflight',
    releaseReady: false,
    generatedAt: new Date().toISOString(),
    repository: {
      head: git(['rev-parse', 'HEAD']).trim(),
      branch: git(['branch', '--show-current']).trim(),
      trackedPatch: {
        file: 'tracked.patch',
        bytes: patch.length,
        sha256: sha256(patch),
      },
      untrackedInputs: collection('untracked-inputs.nul', untrackedPaths, untracked),
      ignoredDocumentation: collection('ignored-doc-inputs.nul', ignoredDocPaths, docs),
      packageLockSha256: sha256(readFileSync('package-lock.json')),
    },
    runtime: {
      node: process.version,
      npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
    },
    fixtureAudit: { dependencies, ignoredRuntimeInputs, missingRuntimeInputs },
    pendingGates: [
      'The supported nested lifecycle is implemented and has native wire oracles; the final source-frozen run must repeat its MCP and three native removal variants.',
      'Native Delete Node retains a commercial configuration in its export but Lenovo drops that detached node on reimport. The MCP exposes this as detach with an explicit warning; use unplace for roundtrip retention.',
      'Manual Management/100GbE creation and shared 10GbE DAC storage replacement are implemented; repeat their public recovery/export/browser gates from this source snapshot.',
      'FC/optical-iSCSI probes remain unavailable for the tested hardware/catalog combinations; this does not block the verified 10GbE DAC storage workflows or prove universal API absence.',
      'Native website CFXML import degrades the captured four-way breakout shape. Only that exact independently verified mismatch is a declared blocked result in the breakout gates.',
      'Legacy companion-workbook recovery still needs genuine nonempty legacy input. Broader topologies/layouts and authenticated account/partner workflows remain outside verified coverage.',
      'Terminal valid and deliberately invalid manufacturing verdicts pass development acceptance with bounded public responses, full paged diagnostics and canonical provenance; repeat these checks from the final source-frozen snapshot.',
      'Run every release command from one materialized source snapshot only after integration is frozen.',
    ],
    releaseCommands: RELEASE_COMMANDS,
    materializeSteps: [
      'export SOURCE_ROOT=<absolute path to the source checkout used to create this manifest>',
      'export MANIFEST_DIR=<absolute path to the directory containing manifest.json>',
      'export CHECKOUT=<absolute path for the disposable review checkout>',
      'git worktree add --detach "$CHECKOUT" <manifest.repository.head>',
      'git -C "$CHECKOUT" apply --binary "$MANIFEST_DIR/tracked.patch"',
      'tar -C "$SOURCE_ROOT" --null -cf - -T "$MANIFEST_DIR/untracked-inputs.nul" | tar -xf - -C "$CHECKOUT"',
      'tar -C "$SOURCE_ROOT" --null -cf - -T "$MANIFEST_DIR/ignored-doc-inputs.nul" | tar -xf - -C "$CHECKOUT"',
      'cd "$CHECKOUT" && npm ci',
      'npx tsx scripts/release-checkpoint.ts --verify "$MANIFEST_DIR/manifest.json"',
      'Run manifest.releaseCommands serially, recording exit code, pass/fail/blocked counts and artifact path.',
    ],
  };
  writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(outDir, 'README.md'), preflightReadme(manifest));
  process.stdout.write(`${JSON.stringify({
    manifest: path.join(outDir, 'manifest.json'),
    head: manifest.repository.head,
    trackedPatchSha256: manifest.repository.trackedPatch.sha256,
    untrackedInputs: untracked.length,
    fixtureDependencies: dependencies.length,
    ignoredRuntimeInputs,
    missingRuntimeInputs,
    releaseReady: false,
  }, null, 2)}\n`);
}

function verify(manifestPath: string): void {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  assert.equal(manifest.schemaVersion, 2);
  const manifestDir = path.dirname(manifestPath);
  assert.equal(git(['rev-parse', 'HEAD']).trim(), manifest.repository.head, 'HEAD differs from the manifest.');
  const patch = execFileSync('git', ['diff', '--binary', '--full-index', '--no-ext-diff', 'HEAD', '--'], {
    cwd: process.cwd(),
  });
  assert.equal(sha256(patch), manifest.repository.trackedPatch.sha256, 'Tracked patch differs from the manifest.');
  const recordedPatch = readFileSync(path.join(manifestDir, manifest.repository.trackedPatch.file));
  assert.deepEqual(
    { bytes: recordedPatch.length, sha256: sha256(recordedPatch) },
    { bytes: manifest.repository.trackedPatch.bytes, sha256: manifest.repository.trackedPatch.sha256 },
    'The recorded tracked.patch file differs from the manifest.',
  );
  assert.deepEqual(nulGitFiles(['ls-files', '--others', '--exclude-standard']),
    manifest.repository.untrackedInputs.files.map(file => file.path),
    'The untracked source path set differs from the manifest.');
  for (const group of [manifest.repository.untrackedInputs, manifest.repository.ignoredDocumentation]) {
    const expectedList = nulPathList(group.files.map(file => file.path));
    const recordedList = readFileSync(path.join(manifestDir, group.listFile));
    assert.deepEqual(
      { bytes: recordedList.length, sha256: sha256(recordedList) },
      { bytes: group.listBytes, sha256: group.listSha256 },
      `${group.listFile} differs from the manifest.`,
    );
    assert.equal(recordedList.equals(expectedList), true,
      `${group.listFile} does not enumerate the manifest files in order.`);
    const actual = group.files.map(expected => {
      const current = digestFile(expected.path);
      assert.deepEqual(
        current,
        expected,
        `${expected.path} differs from the manifest.`,
      );
      return current;
    });
    assert.equal(treeSha256(actual), group.treeSha256);
  }
  assert.equal(sha256(readFileSync('package-lock.json')), manifest.repository.packageLockSha256);
  process.stdout.write(`${JSON.stringify({ verified: true, head: manifest.repository.head,
    releaseReady: manifest.releaseReady, pendingGates: manifest.pendingGates }, null, 2)}\n`);
}

function preflightReadme(manifest: Manifest): string {
  return `# Release checkpoint preflight\n\n` +
    `This is a source-input manifest, not a completed release result. ` +
    `\`releaseReady\` is deliberately false while integration remains active.\n\n` +
    `- HEAD: \`${manifest.repository.head}\`\n` +
    `- tracked patch: \`${manifest.repository.trackedPatch.sha256}\`\n` +
    `- untracked source inputs: ${manifest.repository.untrackedInputs.count}\n` +
    `- fixture dependencies: ${manifest.fixtureAudit.dependencies.length}\n` +
    `- ignored runtime inputs: ${manifest.fixtureAudit.ignoredRuntimeInputs.length}\n` +
    `- explicit ignored review docs: ${manifest.repository.ignoredDocumentation.count}\n\n` +
    `Use the ordered \`materializeSteps\` in \`manifest.json\` after source freeze. ` +
    `A blocked release command remains nonzero and must be recorded separately from a pass.\n`;
}

function parseArgs(argv = process.argv.slice(2)): { mode: 'prepare'; outDir: string } | { mode: 'verify'; manifest: string } {
  if (argv[0] === '--verify') {
    assert(argv[1], '--verify requires a manifest path.');
    assert.equal(argv.length, 2, 'Unexpected arguments after --verify.');
    return { mode: 'verify', manifest: path.resolve(argv[1]) };
  }
  let outDir = path.resolve(`artifacts/release-preflight/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  if (argv.length > 0) {
    assert.equal(argv[0], '--out', 'Use --out <directory> or --verify <manifest>.');
    assert(argv[1], '--out requires a directory.');
    assert.equal(argv.length, 2, 'Unexpected arguments after --out.');
    outDir = path.resolve(argv[1]);
  }
  return { mode: 'prepare', outDir };
}

const args = parseArgs();
if (args.mode === 'verify') verify(args.manifest);
else prepare(args.outDir);
