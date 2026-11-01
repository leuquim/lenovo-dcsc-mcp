/** Mixed LFO workspace (preconfigured hardware and standalone software): website-authored source, MCP edit, website oracle. */
import type { ParityCase } from '../harness.js';
import { LFO_VARIANT, runMixedSoftwareCase } from '../mixedSoftware.js';

export default {
  id: 'software-lfo',
  tags: ['software', 'export'],
  run: h => runMixedSoftwareCase(h, LFO_VARIANT),
} satisfies ParityCase;
