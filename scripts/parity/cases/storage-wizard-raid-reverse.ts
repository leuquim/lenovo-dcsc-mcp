/** Storage wizard: RAID mode switch and back. */
import type { ParityCase } from '../harness.js';
import { runStorageWizard } from './storage-wizard.js';

export default {
  id: 'storage-wizard-raid-reverse',
  tags: ['wizard', 'storage'],
  run: h => runStorageWizard(h, 'raid-reverse'),
} satisfies ParityCase;
