/** Switch Clone Multiple followed by a linked edit on the clone. */
import type { ParityCase } from '../harness.js';
import { runSwitchClone } from './switch-clone.js';

export default {
  id: 'switch-edit',
  tags: ['rack', 'clone', 'hpc'],
  run: h => runSwitchClone(h, true),
} satisfies ParityCase;
