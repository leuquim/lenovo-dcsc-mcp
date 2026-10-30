import { expect, it } from 'vitest';
import { assertGroupedCommercialParity } from '../scripts/lib/groupedRackParity.js';

it('compares derived physical storage prices and multiplicity, and still rejects a wrong physical price', () => {
  const raw = { id: 'template', code: 'controller', totalPrice: 100, tabs: [] };
  const physical = { ...raw, totalPrice: 125 };
  const saved = {
    configurations: [{ configurationId: 'template', raw }],
    rackArea: [], nonRackArea: ['first', 'second'].map(id => ({ id, code: 'controller', type: 'storage' })),
    serverState: {
      storageConnectionNetworks: [{ name: 'Storage', controller: { id: 'template', option: 'controller', hardwareType: 'storage' } }],
      cloneDependency: { template: ['template', 'first', 'second'] },
      storagePhysicalConfigurations: { first: physical, second: physical },
    },
  };
  const native = { configuration: [{ ...physical, id: 'native' }],
    workspace: { nonRackArea: [{ configurationId: 'native', quantity: 2, originalIds: ['first', 'second'] }] } };
  expect(() => assertGroupedCommercialParity(native, saved)).not.toThrow();
  saved.serverState.storagePhysicalConfigurations.second = { ...physical, totalPrice: 124 };
  expect(() => assertGroupedCommercialParity(native, saved)).toThrow(/prices differ/);
});
