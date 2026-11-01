/** Nested chassis: native import, clone, copy, linked edits, restart and browser export handoff. */
import type { ParityCase } from '../harness.js';
import { runNestedChassis, type NestedVariant } from '../nestedChassis.js';

const variants: Record<string, NestedVariant> = {
  'nested-grouped-import': {},
  'chassis-clone': { create: 'clone' },
  'chassis-copy': { create: 'copy' },
  'chassis-linked-copy': { linkedCopy: 'root' },
  'chassis-member-copy': { linkedCopy: 'member' },
  'chassis-parent-edit': { parentEdit: true },
};

export default Object.entries(variants).map(([id, variant]): ParityCase => ({
  id, tags: ['rack', 'nested', 'import'], run: h => runNestedChassis(h, variant),
}));
