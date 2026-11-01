import { isDeepStrictEqual } from 'node:util';

import { aggregatePower, extractPowerReport } from '../domain/power.js';
import { storagePhysicalTemplateIds, storageComponentQuantities } from '../domain/storagePreferences.js';
import { storagePhysicalConfigurations } from '../domain/storagePhysicalState.js';
import { physicalIds } from '../domain/workspaceReferences.js';
import type { Runtime } from './runtime.js';

function positiveQuantity(quantity: number | null | undefined): number {
  return typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
}

/** Power and heat figures per configuration, per rack and in total, for a configuration or a whole workspace. */
export function powerReport(rt: Runtime, handle: string): Record<string, unknown> {
  const resolved = rt.sessions.resolveHandle(handle);
  if (!resolved) throw new Error(`Session / Workspace ${handle} not found`);
  const workspace = resolved.workspace;
  const configs =
    resolved.kind === 'workspace'
      ? [...resolved.workspace.configurations.values()]
      : [resolved.session];
  const storageQuantities = resolved.kind === 'workspace'
    ? storageComponentQuantities(resolved.workspace) : new Map<string, number>();
  const units = new Map(configs.map(session => [session.id,
    workspace && storageQuantities.has(session.configurationId)
      ? storagePhysicalConfigurations(workspace, session.configurationId, session.raw)
          .map(instance => ({ ...instance, quantity: 1, power: extractPowerReport(instance.raw) }))
      : [{ physicalId: session.configurationId, raw: session.raw, quantity: positiveQuantity(session.raw.quantity),
          power: extractPowerReport(session.raw) }],
  ]));
  const perConfig = configs.map((s) => ({
    session: s.id,
    configurationId: s.configurationId,
    code: s.product.code,
    description: s.product.description,
    salesQuantity: storageQuantities.get(s.configurationId) ?? positiveQuantity(s.raw.quantity),
    ...(storageQuantities.has(s.configurationId) ? { managedStorageTemplate: true } : {}),
    power: units.get(s.id)!.every(unit => isDeepStrictEqual(unit.power, units.get(s.id)![0]?.power))
      ? units.get(s.id)![0]?.power : undefined,
    ...(storageQuantities.has(s.configurationId) ? { physicalInstances: units.get(s.id)!.map(unit => ({
      physicalId: unit.physicalId, power: unit.power,
    })) } : {}),
  }));

  const contributing = [...units.values()].flat().filter(
    (p): p is typeof p & { power: NonNullable<typeof p.power> } => p.power !== undefined && p.quantity > 0);
  const total =
    contributing.length > 0
      ? aggregatePower(
          contributing.map((p) => ({ report: p.power, quantity: p.quantity })),
        )
      : undefined;

  const missingPowerConfigurations = perConfig.filter(entry => entry.salesQuantity > 0 && units.get(entry.session)!.some(unit => !unit.power) &&
    configs.find(config => config.id === entry.session)?.product.type.toLowerCase() !== 'rack')
    .map(entry => entry.session);
  const totalPowerAvailable = total !== undefined && missingPowerConfigurations.length === 0;

  const sessionByPhysicalId = new Map<string, (typeof configs)[number]>();
  for (const session of configs) {
    sessionByPhysicalId.set(session.id, session);
    sessionByPhysicalId.set(session.configurationId, session);
  }
  if (workspace) for (const [physicalId, templateId] of storagePhysicalTemplateIds(workspace)) {
    const template = sessionByPhysicalId.get(templateId);
    if (template) sessionByPhysicalId.set(physicalId, template);
  }
  const placedBySession = new Map<string, number>();

  const perRack = (workspace?.rackSummaries ?? [])
    .map((rack) => {
      let scopedPlacements = 0;
      const missingPowerConfigurations: string[] = [];
      const rawRack = workspace?.rackArea.find(item => item.id === rack.id);
      const placedIds = rawRack ? [...physicalIds(rawRack)].filter(id => id !== rack.id)
        : rack.items.map(item => item.id);
      const physicalEntries = placedIds.flatMap((physicalId) => {
        const session = sessionByPhysicalId.get(physicalId);
        if (!session) return [];
        scopedPlacements += 1;
        placedBySession.set(session.id, (placedBySession.get(session.id) ?? 0) + 1);
        const report = units.get(session.id)?.find(unit => unit.physicalId === physicalId)?.power ??
          (!storageQuantities.has(session.configurationId) ? extractPowerReport(session.raw) : undefined);
        if (!report && session.product.type.toLowerCase() !== 'rack') missingPowerConfigurations.push(session.id);
        return report ? [{ report, quantity: 1 }] : [];
      });
      return {
        rackId: rack.id,
        code: rack.code,
        physicallyPlacedUnits: scopedPlacements,
        powerContributors: physicalEntries.length,
        powerAvailable: physicalEntries.length > 0 && missingPowerConfigurations.length === 0,
        ...(physicalEntries.length > 0 && missingPowerConfigurations.length === 0
          ? aggregatePower(physicalEntries)
          : { missingPowerConfigurations, ...(physicalEntries.length > 0
            ? { knownPowerSubtotal: aggregatePower(physicalEntries) } : {}) }),
      };
    })
    .filter((rack) => resolved.kind === 'workspace' || rack.physicallyPlacedUnits > 0);

  const unplacedSalesUnits = perConfig
    .filter((entry) => {
      const session = configs.find((candidate) => candidate.id === entry.session);
      return session?.product.type.toLowerCase() !== 'rack';
    })
    .map((entry) => {
      const placedUnits = placedBySession.get(entry.session) ?? 0;
      return {
        session: entry.session,
        configurationId: entry.configurationId,
        code: entry.code,
        salesQuantity: entry.salesQuantity,
        physicallyPlacedUnits: placedUnits,
        unplacedUnits: Math.max(0, entry.salesQuantity - placedUnits),
        ...(placedUnits > entry.salesQuantity
          ? {
              warning:
                'The validated rack layout contains more physical instances than the sales quantity.',
            }
          : {}),
      };
    })
    .filter((entry) => entry.unplacedUnits > 0 || entry.warning !== undefined);

  const voltages = [
    ...new Set(contributing.map((p) => p.power.operatingVoltage).filter(Boolean)),
  ];

  return {
    session: handle,
    ...(workspace ? { revision: workspace.revision } : {}),
    currency:
      resolved.kind === 'workspace'
        ? resolved.workspace.locale.currency
        : resolved.session.locale.currency,
    perConfiguration: perConfig,
    totalPowerAvailable,
    ...(totalPowerAvailable
      ? { total, totalScope: 'sales quantities across the selected scope' }
      : { missingPowerConfigurations, ...(total ? { knownPowerSubtotal: total } : {}),
        powerAvailabilityReason: 'DCSC did not supply a complete numeric power report for every included powered configuration.' }),
    ...(perRack.length > 0 ? { perRack } : {}),
    unplacedSalesUnits,
    operatingVoltage: voltages.length === 1 ? voltages[0] : voltages,
    ...(voltages.length > 1
      ? {
          voltageWarning:
            'Configurations run at different voltages, so the summed current figure is not meaningful. ' +
            'Compare power (W) instead.',
        }
      : {}),
    note:
      'idle / expected / max / worst are DCSC\'s own bands. "expected" applies the configured ' +
      'load factor and is the figure to size a room against; "worst" is what a breaker must survive.',
  };
}
