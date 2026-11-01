/** Storage wizard: RAID mode switch clearing the storage option. */
import type { ParityCase } from '../harness.js';
import { runStorageWizard } from './storage-wizard.js';

export default {
  id: 'storage-wizard-raid',
  tags: ['wizard', 'storage'],
  run: h => runStorageWizard(h, 'raid'),
} satisfies ParityCase;
