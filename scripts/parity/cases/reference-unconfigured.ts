/** Reference Customize followed by the unconfigured-software quantity edit, compared with the native UI edit. */
import type { ParityCase } from '../harness.js';
import { runReferenceSolutionCase } from '../referenceSolution.js';

export default {
  id: 'reference-unconfigured',
  tags: ['reference', 'import'],
  run: h => runReferenceSolutionCase(h, { editUnconfigured: true }),
} satisfies ParityCase;
