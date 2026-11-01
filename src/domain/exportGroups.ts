import { isDeepStrictEqual } from 'node:util';

import type { ConfigMode } from '../config/constants.js';
import type { RawConfiguration } from '../model/types.js';
import { hardwareModeFamily } from './modeFamily.js';
import { storageComponentQuantities } from './storagePreferences.js';
import { storagePhysicalConfigurations } from './storagePhysicalState.js';
import { adjustUnconfiguredPrices, unconfiguredProducts } from './unconfigured.js';
import type { Obj } from '../util/coerce.js';


export interface ExportGroup {
  name: string;
  parent: null;
  index: -1;
  products: ExportGroupProduct[];
}

export interface ExportGroupProduct extends Obj {
  id: string;
  code: string;
  description: string;
  quantity: number;
  price: number | null;
  unitPrice: number | null;
  type: 'hardware' | 'hipo' | 'service' | 'servicectohipo' | 'added-options' | 'unconfigured';
  groupId: string;
  priceNotAvailable?: boolean | undefined;
  showPrice: boolean;
}

interface ConfigurationForGroup {
  id: string;
  raw: RawConfiguration;
  fallbackCode?: string | undefined;
  mode?: ConfigMode | undefined;
}

/** Minimal structural input so the serializer is independent of session storage. */
export interface ExportGroupWorkspace {
  serverState?: Obj;
  rackArea?: Obj[];
  nonRackArea?: Obj[];
  configurations: ReadonlyMap<
    string,
    {
      configurationId: string;
      raw: RawConfiguration;
      product: { code: string };
      mode?: ConfigMode | undefined;
    }
  >;
}

const GROUP_NAME = 'Config 1';
const SINGLE_USE = 'Single-use';

/**
 * Builds the hidden export form's `groups` field for either one configuration
 * or every configuration in a workspace.
 *
 * DCSC's `totalPrice` includes HIPO software and service lines. The website
 * subtracts those child lines from the hardware unit price, then emits each
 * child as its own product. Keeping the inclusive total as the hardware price
 * duplicates thousands of dollars in Quote/Quote Group exports.
 */
export function buildExportGroups(
  source: RawConfiguration | ExportGroupWorkspace,
  configurationId?: string,
  mode?: ConfigMode,
): ExportGroup[] {
  const storageQuantities = isWorkspace(source) ? storageComponentQuantities(source) : new Map<string, number>();
  const unplacedControllers = new Set([...storageQuantities].filter(([, quantity]) => quantity === 0).map(([id]) => id));
  const configurations = isWorkspace(source)
    ? [...source.configurations.values()].map((session) => ({
        id: session.configurationId,
        raw: session.raw,
        fallbackCode: session.product.code,
        mode: session.mode,
      }))
    : [
        {
          id: configurationId ?? string(source.id),
          raw: source,
          mode,
        },
      ];

  const missingId = configurations.find((configuration) => configuration.id === '');
  if (missingId) {
    throw new Error('A DCSC configuration id is required to build export groups.');
  }

  const entries = configurations.map(configuration => {
    const products = productsForConfiguration(configuration);
    const physicalQuantity = storageQuantities.get(configuration.id);
    return {
      id: configuration.id,
      products: unplacedControllers.has(configuration.id)
        // Commercial quantities are physical for managed controller templates.
        // HIPO/service price fields remain per-configuration, as in the form.
        ? products.filter(product => product.type === 'hardware' || product.type === 'hipo').map(product => ({ ...product, quantity: 0,
            ...(product.type === 'hardware' && product.price !== null ? { price: 0 } : {}),
          }))
        : physicalQuantity !== undefined && isWorkspace(source)
          ? combinePhysicalProducts(storagePhysicalConfigurations(source, configuration.id, configuration.raw)
              .flatMap(instance => productsForConfiguration({ ...configuration, raw: instance.raw })))
          : products,
    };
  });
  const products = isWorkspace(source)
    ? aggregateCloneGroups(entries, source.serverState?.['cloneDependency'], unplacedControllers)
    : entries.flatMap(entry => entry.products);

  return [
    {
      name: GROUP_NAME,
      parent: null,
      index: -1,
      products,
    },
  ];
}

/** Combine equal commercial lines; different physical prices remain separate quote lines. */
function combinePhysicalProducts(products: ExportGroupProduct[]): ExportGroupProduct[] {
  const combined: ExportGroupProduct[] = [];
  const comparable = (product: ExportGroupProduct) => ({ ...product, quantity: 0,
    ...(product.type === 'hardware' ? { price: null } : {}) });
  for (const product of products) {
    const match = combined.find(candidate => isDeepStrictEqual(comparable(candidate), comparable(product)));
    if (!match) combined.push({ ...product });
    else {
      match.quantity += product.quantity;
      if (match.type === 'hardware') match.price = match.price === null || product.price === null
        ? null : money(match.price + product.price);
    }
  }
  return combined;
}

function aggregateCloneGroups(
  entries: Array<{ id: string; products: ExportGroupProduct[] }>,
  rawDependency: unknown,
  unplacedControllers: ReadonlySet<string>,
): ExportGroupProduct[] {
  const dependency = object(rawDependency);
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const memberToRoot = new Map<string, string>();
  for (const [root, rawMembers] of Object.entries(dependency)) {
    if (!Array.isArray(rawMembers) || rawMembers.length < 2) continue;
    const members = rawMembers.filter((member): member is string => typeof member === 'string');
    if (members.length !== rawMembers.length || new Set(members).size !== members.length ||
        !members.includes(root) || !members.every(member => byId.has(member)) ||
        members.some(member => unplacedControllers.has(member))) continue;
    for (const member of members) {
      if (memberToRoot.has(member)) throw new Error(`Clone dependency identity ${member} belongs to multiple commercial groups.`);
      memberToRoot.set(member, root);
    }
  }

  const emitted = new Set<string>();
  const result: ExportGroupProduct[] = [];
  for (const entry of entries) {
    if (emitted.has(entry.id)) continue;
    const root = memberToRoot.get(entry.id);
    if (!root) {
      result.push(...entry.products);
      emitted.add(entry.id);
      continue;
    }
    if (root !== entry.id) continue;
    const members = (dependency[root] as string[]).map(member => byId.get(member)!);
    const expected = entry.products.map(product => ({ ...product, id: root }));
    const expectedCommercial = expected.map(commercialCloneComparable);
    for (const member of members.filter(member => member.id !== root)) {
      const comparable = member.products.map(product => ({ ...product, id: root }));
      if (!isDeepStrictEqual(comparable.map(commercialCloneComparable), expectedCommercial)) {
        throw new Error(`Clone dependency group ${root} has divergent commercial selections or prices and cannot be collapsed safely.`);
      }
    }
    result.push(...expected.map((product, index) => {
      const matching = members.map(member => member.products[index]!);
      const quantity = matching.reduce((sum, value) => sum + value.quantity, 0);
      if (product.type !== 'hardware') return { ...product, quantity };
      const price = matching.some(value => value.price === null)
        ? null
        : money(matching.reduce((sum, value) => sum + (value.price ?? 0), 0));
      return { ...product, quantity, price };
    }));
    for (const member of members) emitted.add(member.id);
  }
  // Invalid dependency entries are intentionally serialized independently.
  // Every configuration must remain commercially represented.
  for (const entry of entries) {
    if (!emitted.has(entry.id)) result.push(...entry.products);
  }
  return result;
}

/**
 * DCSC hydrates availability only on the compressed clone root after import;
 * expanded member configurations can have an empty shippingStatus. That field
 * is presentation metadata and is not a sellable line, selection, or price.
 */
function commercialCloneComparable(product: ExportGroupProduct): Omit<ExportGroupProduct, 'shippingStatus'> {
  const { shippingStatus: _shippingStatus, ...commercial } = product;
  // Native linked references may omit this false flag on a priced root service
  // and emit it on its copies. Keep true/unknown-price differences significant.
  if (commercial.priceNotAvailable === undefined && typeof commercial.price === 'number' && Number.isFinite(commercial.price)) {
    commercial.priceNotAvailable = false;
  }
  return commercial;
}

function productsForConfiguration(configuration: ConfigurationForGroup): ExportGroupProduct[] {
  const { id, raw } = configuration;
  const quantity = positiveQuantity(raw.quantity, 1);
  const showPrice = raw.showPrice !== false;
  const unconfigured = unconfiguredProducts(raw);
  const priceNotAvailable = raw.priceNotAvailable === true ||
    typeof raw.totalPrice !== 'number' || !Number.isFinite(raw.totalPrice) || unconfigured.some(p => p.price === null);
  let hardwareUnitPrice = number(raw.totalPrice);
  // Restore the priced core before applying the existing native HIPO/service
  // deductions. Subtracting this later introduces a floating-point cent drift.
  if (unconfigured.length > 0) hardwareUnitPrice = money(hardwareUnitPrice -
    unconfigured.reduce((sum, product) => sum + (product.price ?? 0), 0));
  const isLfo = configuration.mode !== undefined
    ? hardwareModeFamily(configuration.mode) === 'lfo'
    : isLfoConfiguration(raw);

  const hipoProducts: ExportGroupProduct[] = [];
  let hipoDeduction = 0;
  for (const value of array(raw.hipoDerivedItems)) {
    const hipo = object(value);
    const targetQuantity = positiveQuantity(hipo['targetCtoQuantity'], 1);
    const targetPrice = number(hipo['targetCtoPrice']);
    const targetUnitPrice = number(hipo['targetCtoUnitPrice']);
    const deductedPrice = money(targetPrice * targetQuantity + targetUnitPrice);
    hipoDeduction += deductedPrice;
    hipoProducts.push(
      ...buildHipoProducts({
        id,
        hipo,
        configurationQuantity: quantity,
        targetQuantity,
        targetPrice,
        targetUnitPrice,
        showPrice,
      }),
    );
  }
  hardwareUnitPrice -= hipoDeduction;

  const selectedServices = selectedServiceProducts(raw, id, quantity, showPrice, isLfo);
  hardwareUnitPrice -= selectedServices.deduction;
  const unconfiguredRows: ExportGroupProduct[] = unconfigured.map(product => ({ ...product, id,
    quantity: product.quantity * quantity, price: product.price === null ? null : money(product.price * quantity),
    type: 'unconfigured', showPrice, asMultiProd: false, groupId: GROUP_NAME }));

  const serviceCtoProducts: ExportGroupProduct[] = [];
  for (const value of array(raw.hipoServiceCtoServices)) {
    const service = object(value);
    const unitPrice = number(service['price']);
    const servicePriceUnavailable = service['priceNotAvailable'] === true;
    hardwareUnitPrice -= unitPrice;
    serviceCtoProducts.push({
      code: string(service['targetCto']),
      description: string(service['description']),
      titleType: 'serviceCtoHipo',
      type: 'servicectohipo',
      id,
      price: servicePriceUnavailable ? null : unitPrice,
      quantity,
      unitPrice: servicePriceUnavailable ? null : unitPrice,
      ...(typeof service['priceNotAvailable'] === 'boolean'
        ? { priceNotAvailable: service['priceNotAvailable'] }
        : {}),
      showPrice,
      groupId: GROUP_NAME,
    });
  }

  hardwareUnitPrice = browserMoney(hardwareUnitPrice);
  const code = isLfo
    ? string(raw.lfoCode) || string(raw['code']) || configuration.fallbackCode || ''
    : string(raw.sliceCtoCode) || string(raw['ctoCode']) || string(raw['code']) || configuration.fallbackCode || '';
  const hardware: ExportGroupProduct = {
    id,
    quantity,
    price: priceNotAvailable ? null : money(hardwareUnitPrice * quantity),
    prices: array(adjustUnconfiguredPrices(raw.totalPrices, raw, -1)),
    type: 'hardware',
    description: string(raw.description),
    shippingStatus: array(raw.shippingStatus),
    asMultiProd: raw['asMultiProd'] === true,
    priceNotAvailable,
    unitPrice: priceNotAvailable ? null : hardwareUnitPrice,
    code,
    showPrice,
    specialBid: raw['specialBid'] === true,
    groupId: GROUP_NAME,
  };

  return [hardware, ...hipoProducts, ...serviceCtoProducts, ...selectedServices.products, ...unconfiguredRows];
}

function buildHipoProducts(opts: {
  id: string;
  hipo: Obj;
  configurationQuantity: number;
  targetQuantity: number;
  targetPrice: number;
  targetUnitPrice: number;
  showPrice: boolean;
}): ExportGroupProduct[] {
  const features = array(opts.hipo['features']).map(object);
  const anyUnavailable = features.some((feature) => feature['priceNotAvailable'] === true);
  const priceNotAvailable = opts.hipo['priceNotAvailable'] === true || anyUnavailable;
  const linePrice = money(
    opts.targetPrice * opts.targetQuantity + opts.targetUnitPrice + opts.targetUnitPrice,
  );
  const totalQuantity = opts.configurationQuantity * opts.targetQuantity;

  const singleUse = aggregateFeatures(
    features.filter((feature) => feature['subCategory'] === SINGLE_USE),
  );
  const recurring = aggregateFeatures(
    features.filter((feature) => feature['subCategory'] !== SINGLE_USE),
  );
  const allSingleUse = features.length > 0 && recurring.size === 0;
  const singleUsePrice = aggregatePrice(singleUse);
  const recurringPrice = aggregatePrice(recurring);

  const product = (quantity: number, unitPrice: number): ExportGroupProduct => ({
    id: opts.id,
    code: string(opts.hipo['targetCtoCode']),
    description: string(opts.hipo['targetCtoCodeDescription']),
    quantity,
    price: priceNotAvailable ? null : linePrice,
    prices: array(opts.hipo['targetCTOPrices']),
    unitPrice: priceNotAvailable ? null : money(unitPrice),
    targetCtoUnitPrice: opts.targetUnitPrice,
    type: 'hipo',
    priceNotAvailable,
    showPrice: opts.showPrice,
    asMultiProd: false,
    groupId: GROUP_NAME,
  });

  if (allSingleUse) {
    return singleUse.size === 0 ? [] : [product(1, opts.targetUnitPrice + singleUsePrice)];
  }
  if (totalQuantity > 1 && singleUse.size > 0) {
    return [
      product(1, opts.targetUnitPrice + singleUsePrice + recurringPrice),
      product(totalQuantity - 1, opts.targetUnitPrice + recurringPrice),
    ];
  }
  return [product(totalQuantity, opts.targetUnitPrice + recurringPrice)];
}

function selectedServiceProducts(
  raw: RawConfiguration,
  id: string,
  configurationQuantity: number,
  showPrice: boolean,
  isLfo: boolean,
): { products: ExportGroupProduct[]; deduction: number } {
  const products = new Map<string, ExportGroupProduct>();
  let deduction = 0;
  for (const tab of array(raw.tabs)) {
    const tabRecord = object(tab);
    const addedOptions = isLfo && string(tabRecord['type']).toLowerCase() === 'servicesandor';
    for (const subTab of array(tabRecord['subTabs'])) {
      for (const sectionValue of array(object(subTab)['sections'])) {
        const section = object(sectionValue);
        const features = array(section['features']).map(object);
        for (const resultValue of array(section['results'])) {
          const result = object(resultValue);
          if (string(result['type']).toLowerCase() !== 'service' && !addedOptions) continue;
          const code = string(result['code']);
          if (code === '' || products.has(code)) continue;
          const feature = features.find((candidate) => string(candidate['code']) === code) ?? {};
          const selectedQuantity = positiveQuantity(result['quantity'], 1);
          const unitPrice = firstNumber(feature['unitPrice'], result['price'], result['cost']);
          const unavailable =
            feature['priceNotAvailable'] === true || result['priceNotAvailable'] === true;
          const declaredUnavailable =
            typeof feature['priceNotAvailable'] === 'boolean'
              ? feature['priceNotAvailable']
              : result['priceNotAvailable'];
          deduction = money(deduction + unitPrice * selectedQuantity);
          products.set(code, {
            id,
            code,
            description: string(feature['description']) || string(result['description']),
            quantity: configurationQuantity * selectedQuantity,
            price: unavailable ? null : money(unitPrice * selectedQuantity),
            prices: array(feature['prices']),
            type: addedOptions ? 'added-options' : 'service',
            unitPrice: unavailable ? null : unitPrice,
            showPrice,
            asMultiProd: false,
            ...(typeof declaredUnavailable === 'boolean'
              ? { priceNotAvailable: declaredUnavailable }
              : {}),
            groupId: GROUP_NAME,
          });
        }
      }
    }
  }
  return { products: [...products.values()], deduction };
}

/**
 * Imported LFO trees identify the sellable code in `code` and retain their
 * underlying configurable model in `ctoCode`. Some callers build a single
 * group without a session, so retain this captured wire-level fallback in
 * addition to the authoritative session mode used for workspace exports.
 */
function isLfoConfiguration(raw: RawConfiguration): boolean {
  const code = string(raw['code']);
  const lfoCode = string(raw.lfoCode);
  if (code !== '' && lfoCode !== '') return code.toUpperCase() === lfoCode.toUpperCase();
  const ctoCode = string(raw['ctoCode']);
  return code !== '' && ctoCode !== '' && code.toUpperCase() !== ctoCode.toUpperCase();
}

function aggregateFeatures(features: Obj[]): Map<string, { quantity: number; unitPrice: number }> {
  const aggregate = new Map<string, { quantity: number; unitPrice: number }>();
  for (const feature of features) {
    const code = string(feature['featureCode']);
    const quantity = number(feature['quantity']);
    const unitPrice = number(feature['unitPrice']);
    const existing = aggregate.get(code);
    if (existing) existing.quantity += quantity;
    else aggregate.set(code, { quantity, unitPrice });
  }
  return aggregate;
}

function aggregatePrice(features: Map<string, { quantity: number; unitPrice: number }>): number {
  let total = 0;
  for (const feature of features.values()) total += feature.quantity * feature.unitPrice;
  return money(total);
}

function isWorkspace(
  value: RawConfiguration | ExportGroupWorkspace,
): value is ExportGroupWorkspace {
  return value['configurations'] instanceof Map;
}

function object(value: unknown): Obj {
  return typeof value === 'object' && value !== null ? (value as Obj) : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function firstNumber(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

function positiveQuantity(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Browser groups truncate the inclusive-price remainder at two decimals. */
function browserMoney(value: number): number {
  return Math.floor((value + Number.EPSILON) * 100) / 100;
}
