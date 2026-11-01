/** Reference catalog paging and Customize against the native Customize button, stdio restart and fresh-browser reimport. */
import type { ParityCase } from '../harness.js';
import { runReferenceSolutionCase } from '../referenceSolution.js';

export default {
  id: 'reference-solutions',
  tags: ['reference', 'import'],
  run: h => runReferenceSolutionCase(h, { editUnconfigured: false }),
} satisfies ParityCase;
