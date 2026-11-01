/** PCI wizard edit on the non-root member of a linked clone pair. */
import type { ParityCase } from '../harness.js';
import { runPciWizard } from './pci-wizard.js';

export default {
  id: 'pci-wizard-linked',
  tags: ['wizard', 'pci', 'clone'],
  run: h => runPciWizard(h, true),
} satisfies ParityCase;
