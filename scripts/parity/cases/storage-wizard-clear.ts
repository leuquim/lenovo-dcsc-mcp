/** Storage wizard: whole-option clear with the drive guard. */
import type { ParityCase } from '../harness.js';
import { runStorageWizard } from './storage-wizard.js';

export default {
  id: 'storage-wizard-clear',
  tags: ['wizard', 'storage'],
  run: h => runStorageWizard(h, 'clear'),
} satisfies ParityCase;
