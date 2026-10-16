import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'lenovo-dcsc-test-'));
const configFile = join(root, 'config.json');
writeFileSync(
  configFile,
  JSON.stringify({
    files: {
      persistSessions: false,
      sessionFile: join(root, 'sessions.json'),
      artifactDir: join(root, 'artifacts'),
    },
  }),
);

// Every test file gets a configuration that explicitly disables persistence,
// as well as isolated fallbacks if code constructs a path independently.
process.env.DCSC_CONFIG = configFile;
process.env.XDG_STATE_HOME = join(root, 'state');
process.env.DCSC_ARTIFACT_DIR = join(root, 'artifacts');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
