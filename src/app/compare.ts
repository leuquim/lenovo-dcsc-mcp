import { aggregatePower, assessRackDensity, extractPowerReport } from '../domain/power.js';
import { configurationListPrice } from '../domain/pricing.js';
import { storageComponentQuantities } from '../domain/storagePreferences.js';
import { storagePhysicalConfigurations } from '../domain/storagePhysicalState.js';
import { scaleOut } from './rack.js';
import type { Runtime } from './runtime.js';

export function positiveQuantity(quantity: number | null | undefined): number {
  return typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
}

/** Compares scenarios (configurations or workspaces) by list price, power and heat, optionally scaled to N nodes. */
export function compareScenarios(rt: Runtime, sessions: string[], nodes?: number) {
  const scale = nodes;
  const scenarios = sessions.map((handle) => {
    const resolved = rt.sessions.resolveHandle(handle);
    if (!resolved) throw new Error(`Session / Workspace ${handle} not found`);

    if (
      scale !== undefined &&
      resolved.kind === 'workspace' &&
      resolved.workspace.configurations.size > 1
    ) {
      throw new Error(
        `Workspace ${handle} contains ${resolved.workspace.configurations.size} configurations. ` +
          'Pass the configuration session ID of the node to scale so the repeated and fixed products are explicit.',
      );
    }

    const target =
      resolved.kind === 'configuration'
        ? resolved.session
        : [...resolved.workspace.configurations.values()][0];
    if (!target) throw new Error(`Workspace ${handle} contains no configurations.`);

    const workspace = resolved.workspace;
    const storageQuantities = workspace && (resolved.kind === 'workspace' || scale !== undefined)
      ? storageComponentQuantities(workspace) : new Map<string, number>();
    const scoped =
      resolved.kind === 'workspace'
        ? [...resolved.workspace.configurations.values()]
        : scale !== undefined && workspace
          ? [...workspace.configurations.values()]
          : [target];
    const quantities = new Map(
      scoped.map((session) => [
        session.id,
        scale !== undefined && session.id === target.id
          ? scale
          : storageQuantities.get(session.configurationId) ?? positiveQuantity(session.raw.quantity),
      ]),
    );
    const units = new Map(scoped.map(session => [session.id,
      workspace && storageQuantities.has(session.configurationId) && !(scale !== undefined && session.id === target.id)
        ? storagePhysicalConfigurations(workspace, session.configurationId, session.raw).map(instance => ({ raw: instance.raw, quantity: 1 }))
        : [{ raw: session.raw, quantity: quantities.get(session.id) ?? 1 }],
    ]));
    const entries = scoped.flatMap((session) => {
      return units.get(session.id)!.flatMap(unit => {
        const report = extractPowerReport(unit.raw);
        return report && unit.quantity > 0 ? [{ report, quantity: unit.quantity }] : [];
      });
    });
    const power = entries.length > 0 ? aggregatePower(entries) : undefined;
    const contributing = scoped.filter(session => (quantities.get(session.id) ?? 1) > 0);
    const hasPrice = (session: typeof target) => units.get(session.id)!.every(unit => configurationListPrice(unit.raw) !== null);
    const sessionPrice = (session: typeof target) => units.get(session.id)!.reduce((total, unit) =>
      total + (configurationListPrice(unit.raw) ?? 0) * unit.quantity, 0);
    const priceAvailable = contributing.every(hasPrice);
    const knownListPriceSubtotal = contributing.reduce((total, session) =>
      total + sessionPrice(session), 0);
    const listPrice = priceAvailable ? knownListPriceSubtotal : null;
    const missingPower = contributing.filter(session => session.product.type.toLowerCase() !== 'rack' &&
      units.get(session.id)!.some(unit => !extractPowerReport(unit.raw)));
    const powerAvailable = power !== undefined && missingPower.length === 0;
    const physicalWorkspace = resolved.kind === 'workspace' ? resolved.workspace : undefined;
    const racks = scale === undefined ? (physicalWorkspace?.rackSummaries ?? []) : [];
    const products = scoped.map((session) => ({
      session: session.id,
      code: session.product.code,
      description: session.product.description,
      quantity: quantities.get(session.id) ?? 1,
      role:
        scale === undefined
          ? 'included'
          : session.id === target.id
            ? 'repeated'
            : 'fixed',
      listPrice: (quantities.get(session.id) ?? 1) === 0 ? 0 : hasPrice(session)
        ? sessionPrice(session) : null,
    }));
    return {
      session: handle,
      label: physicalWorkspace?.label ?? target.label ?? target.product.code,
      currency: target.locale.currency,
      scope:
        scale !== undefined
          ? workspace && workspace.configurations.size > 1
            ? 'scaled-configuration-with-fixed-workspace-products'
            : 'scaled-configuration'
          : resolved.kind,
      primaryProduct: target.product.code,
      description: target.product.description,
      configurations: scoped.length,
      products,
      ...(scale !== undefined
        ? {
            scaledToNodes: scale,
            unitListPrice: hasPrice(target) ? target.raw.totalPrice : null,
            physicalLayout: 'not-calculated',
            physicalLayoutRequirement:
              'Use dcsc_compare (analysis "scale-out") with an explicit rackCode, or place independent configuration instances and validate the workspace layout.',
          }
        : {}),
      listPrice,
      priceAvailable,
      ...(!priceAvailable ? { knownListPriceSubtotal,
        unpricedConfigurations: contributing.filter(session => !hasPrice(session)).map(session => session.id) } : {}),
      powerAvailable,
      ...(!powerAvailable ? { missingPowerConfigurations: missingPower.map(session => session.id),
        ...(power ? { knownPowerSubtotal: power } : {}) } : {}),
      ...(power && powerAvailable
        ? {
            expectedKW: power.expectedKW,
            maxKW: power.maxKW,
            heatBtuHrMax: Math.round(power.heatBtuHr.max),
            pricePerExpectedKW:
              listPrice !== null && power.expectedKW > 0 ? Math.round(listPrice / power.expectedKW) : undefined,
          }
        : {}),
      ...(physicalWorkspace && scale === undefined
        ? {
            racks: racks.length,
            rackWeightKg: racks.reduce((acc, rack) => acc + (rack.totalWeightKg ?? 0), 0),
            stability: racks.map((rack) => rack.stableStatus).filter(Boolean),
          }
        : {}),
    };
  });

  const currencies = [...new Set(scenarios.map((scenario) => scenario.currency))];
  if (currencies.length > 1) {
    return {
      scenarios,
      ranking: {
        status: 'rejected',
        reason:
          `Cannot rank list prices across currencies (${currencies.join(', ')}). ` +
          'Relaunch the scenarios in one locale/currency or compare each independently.',
      },
      priceType: 'LIST',
      disclaimer: 'List prices retrieved anonymously. Not a quote.',
    };
  }

  const priceComplete = scenarios.every(scenario => scenario.priceAvailable);
  const byPrice = priceComplete ? [...scenarios].sort((a, b) => (a.listPrice ?? 0) - (b.listPrice ?? 0)) : [];
  const withPower = scenarios.filter(
    (s): s is typeof s & { expectedKW: number } => typeof s.expectedKW === 'number',
  );
  const byPower = withPower.length === scenarios.length
    ? [...withPower].sort((a, b) => a.expectedKW - b.expectedKW) : [];

  return {
    scenarios,
    currency: currencies[0],
    cheapest: byPrice[0]?.session,
    lowestPower: byPower[0]?.session,
    ...(!priceComplete ? { priceRanking: { status: 'unavailable',
      reason: 'At least one included configuration has no available list price. Known subtotals cannot establish the cheapest complete scenario.' } } : {}),
    ...(withPower.length !== scenarios.length ? { powerRanking: { status: 'unavailable',
      reason: 'At least one scenario lacks complete DCSC power reports for its included powered products.' } } : {}),
    priceType: 'LIST',
    note:
      'expectedKW applies DCSC\'s load factor and is the figure to size a room against. ' +
      'pricePerExpectedKW is list price divided by that, useful for comparing accelerator generations.',
    disclaimer:
      'List prices for the configured country and currency, retrieved anonymously. Not a quote.',
  };
}

/** Cluster sizing from one designed node, with DCSC's own placement verdicts. */
export async function sizeScaleOut(rt: Runtime, opts: { session: string; nodes: number; rackCode: string }) {
  const plan = await scaleOut(rt, { sessionHandle: opts.session, nodes: opts.nodes, rackCode: opts.rackCode, ctx: rt.newCtx() });
  const advisory = assessRackDensity(plan.powerPerRack?.maxKW ?? 0, 'unknown');
  return {
    ...plan,
    ...(advisory && advisory.level !== 'standard' ? { coolingAdvisory: advisory } : {}),
    ...(plan.powerPerRack?.maxKW === undefined
      ? {
          powerNote:
            'DCSC returned no power report for this product, so per-rack density could NOT be ' +
            'assessed and no cooling advisory was produced. Absence of a warning here means ' +
            'unknown, not acceptable: size the facility from the vendor datasheet.',
        }
      : {}),
    priceType: 'LIST',
    disclaimer:
      'List prices for the configured country and currency. Not a quote. ' +
      "Power figures are DCSC's for the node as configured, multiplied by node count.",
  };
}
