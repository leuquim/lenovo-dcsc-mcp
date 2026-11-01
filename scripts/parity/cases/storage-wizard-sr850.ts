/** Storage wizard: mixed backplane option and component edits on the SR850. */
import type { ParityCase } from '../harness.js';
import { runStorageWizard } from './storage-wizard.js';

export default {
  id: 'storage-wizard-sr850',
  tags: ['wizard', 'storage'],
  run: h => runStorageWizard(h, 'sr850'),
} satisfies ParityCase;
