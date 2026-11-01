/** Mixed CTO workspace (hardware, attached services, standalone software): website-authored source, MCP edit, website oracle. */
import type { ParityCase } from '../harness.js';
import { CTO_VARIANT, runMixedSoftwareCase } from '../mixedSoftware.js';

export default {
  id: 'software-mixed',
  tags: ['software', 'export'],
  run: h => runMixedSoftwareCase(h, CTO_VARIANT),
} satisfies ParityCase;
