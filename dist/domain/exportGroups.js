import { isDeepStrictEqual } from 'node:util';
import { hardwareModeFamily } from './modeFamily.js';
import { storageComponentQuantities } from './storagePreferences.js';
import { storagePhysicalConfigurations } from './storagePhysicalState.js';
import { adjustUnconfiguredPrices, unconfiguredProducts } from './unconfigured.js';
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
export function buildExportGroups(source, configurationId, mode) {
    const storageQuantities = isWorkspace(source) ? storageComponentQuantities(source) : new Map();
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
function combinePhysicalProducts(products) {
    const combined = [];
    const comparable = (product) => ({ ...product, quantity: 0,
        ...(product.type === 'hardware' ? { price: null } : {}) });
    for (const product of products) {
        const match = combined.find(candidate => isDeepStrictEqual(comparable(candidate), comparable(product)));
        if (!match)
            combined.push({ ...product });
        else {
            match.quantity += product.quantity;
            if (match.type === 'hardware')
                match.price = match.price === null || product.price === null
                    ? null : money(match.price + product.price);
        }
    }
    return combined;
}
function aggregateCloneGroups(entries, rawDependency, unplacedControllers) {
    const dependency = object(rawDependency);
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const memberToRoot = new Map();
    for (const [root, rawMembers] of Object.entries(dependency)) {
        if (!Array.isArray(rawMembers) || rawMembers.length < 2)
            continue;
        const members = rawMembers.filter((member) => typeof member === 'string');
        if (members.length !== rawMembers.length || new Set(members).size !== members.length ||
            !members.includes(root) || !members.every(member => byId.has(member)) ||
            members.some(member => unplacedControllers.has(member)))
            continue;
        for (const member of members) {
            if (memberToRoot.has(member))
                throw new Error(`Clone dependency identity ${member} belongs to multiple commercial groups.`);
            memberToRoot.set(member, root);
        }
    }
    const emitted = new Set();
    const result = [];
    for (const entry of entries) {
        if (emitted.has(entry.id))
            continue;
        const root = memberToRoot.get(entry.id);
        if (!root) {
            result.push(...entry.products);
            emitted.add(entry.id);
            continue;
        }
        if (root !== entry.id)
            continue;
        const members = dependency[root].map(member => byId.get(member));
        const expected = entry.products.map(product => ({ ...product, id: root }));
        const expectedCommercial = expected.map(commercialCloneComparable);
        for (const member of members.filter(member => member.id !== root)) {
            const comparable = member.products.map(product => ({ ...product, id: root }));
            if (!isDeepStrictEqual(comparable.map(commercialCloneComparable), expectedCommercial)) {
                throw new Error(`Clone dependency group ${root} has divergent commercial selections or prices and cannot be collapsed safely.`);
            }
        }
        result.push(...expected.map((product, index) => {
            const matching = members.map(member => member.products[index]);
            const quantity = matching.reduce((sum, value) => sum + value.quantity, 0);
            if (product.type !== 'hardware')
                return { ...product, quantity };
            const price = matching.some(value => value.price === null)
                ? null
                : money(matching.reduce((sum, value) => sum + (value.price ?? 0), 0));
            return { ...product, quantity, price };
        }));
        for (const member of members)
            emitted.add(member.id);
    }
    // Invalid dependency entries are intentionally serialized independently.
    // Every configuration must remain commercially represented.
    for (const entry of entries) {
        if (!emitted.has(entry.id))
            result.push(...entry.products);
    }
    return result;
}
/**
 * DCSC hydrates availability only on the compressed clone root after import;
 * expanded member configurations can have an empty shippingStatus. That field
 * is presentation metadata and is not a sellable line, selection, or price.
 */
function commercialCloneComparable(product) {
    const { shippingStatus: _shippingStatus, ...commercial } = product;
    // Native linked references may omit this false flag on a priced root service
    // and emit it on its copies. Keep true/unknown-price differences significant.
    if (commercial.priceNotAvailable === undefined && typeof commercial.price === 'number' && Number.isFinite(commercial.price)) {
        commercial.priceNotAvailable = false;
    }
    return commercial;
}
function productsForConfiguration(configuration) {
    const { id, raw } = configuration;
    const quantity = positiveQuantity(raw.quantity, 1);
    const showPrice = raw.showPrice !== false;
    const unconfigured = unconfiguredProducts(raw);
    const priceNotAvailable = raw.priceNotAvailable === true ||
        typeof raw.totalPrice !== 'number' || !Number.isFinite(raw.totalPrice) || unconfigured.some(p => p.price === null);
    let hardwareUnitPrice = number(raw.totalPrice);
    // Restore the priced core before applying the existing native HIPO/service
    // deductions. Subtracting this later introduces a floating-point cent drift.
    if (unconfigured.length > 0)
        hardwareUnitPrice = money(hardwareUnitPrice -
            unconfigured.reduce((sum, product) => sum + (product.price ?? 0), 0));
    const isLfo = configuration.mode !== undefined
        ? hardwareModeFamily(configuration.mode) === 'lfo'
        : isLfoConfiguration(raw);
    const hipoProducts = [];
    let hipoDeduction = 0;
    for (const value of array(raw.hipoDerivedItems)) {
        const hipo = object(value);
        const targetQuantity = positiveQuantity(hipo['targetCtoQuantity'], 1);
        const targetPrice = number(hipo['targetCtoPrice']);
        const targetUnitPrice = number(hipo['targetCtoUnitPrice']);
        const deductedPrice = money(targetPrice * targetQuantity + targetUnitPrice);
        hipoDeduction += deductedPrice;
        hipoProducts.push(...buildHipoProducts({
            id,
            hipo,
            configurationQuantity: quantity,
            targetQuantity,
            targetPrice,
            targetUnitPrice,
            showPrice,
        }));
    }
    hardwareUnitPrice -= hipoDeduction;
    const selectedServices = selectedServiceProducts(raw, id, quantity, showPrice, isLfo);
    hardwareUnitPrice -= selectedServices.deduction;
    const unconfiguredRows = unconfigured.map(product => ({ ...product, id,
        quantity: product.quantity * quantity, price: product.price === null ? null : money(product.price * quantity),
        type: 'unconfigured', showPrice, asMultiProd: false, groupId: GROUP_NAME }));
    const serviceCtoProducts = [];
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
    const hardware = {
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
function buildHipoProducts(opts) {
    const features = array(opts.hipo['features']).map(object);
    const anyUnavailable = features.some((feature) => feature['priceNotAvailable'] === true);
    const priceNotAvailable = opts.hipo['priceNotAvailable'] === true || anyUnavailable;
    const linePrice = money(opts.targetPrice * opts.targetQuantity + opts.targetUnitPrice + opts.targetUnitPrice);
    const totalQuantity = opts.configurationQuantity * opts.targetQuantity;
    const singleUse = aggregateFeatures(features.filter((feature) => feature['subCategory'] === SINGLE_USE));
    const recurring = aggregateFeatures(features.filter((feature) => feature['subCategory'] !== SINGLE_USE));
    const allSingleUse = features.length > 0 && recurring.size === 0;
    const singleUsePrice = aggregatePrice(singleUse);
    const recurringPrice = aggregatePrice(recurring);
    const product = (quantity, unitPrice) => ({
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
function selectedServiceProducts(raw, id, configurationQuantity, showPrice, isLfo) {
    const products = new Map();
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
                    if (string(result['type']).toLowerCase() !== 'service' && !addedOptions)
                        continue;
                    const code = string(result['code']);
                    if (code === '' || products.has(code))
                        continue;
                    const feature = features.find((candidate) => string(candidate['code']) === code) ?? {};
                    const selectedQuantity = positiveQuantity(result['quantity'], 1);
                    const unitPrice = firstNumber(feature['unitPrice'], result['price'], result['cost']);
                    const unavailable = feature['priceNotAvailable'] === true || result['priceNotAvailable'] === true;
                    const declaredUnavailable = typeof feature['priceNotAvailable'] === 'boolean'
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
function isLfoConfiguration(raw) {
    const code = string(raw['code']);
    const lfoCode = string(raw.lfoCode);
    if (code !== '' && lfoCode !== '')
        return code.toUpperCase() === lfoCode.toUpperCase();
    const ctoCode = string(raw['ctoCode']);
    return code !== '' && ctoCode !== '' && code.toUpperCase() !== ctoCode.toUpperCase();
}
function aggregateFeatures(features) {
    const aggregate = new Map();
    for (const feature of features) {
        const code = string(feature['featureCode']);
        const quantity = number(feature['quantity']);
        const unitPrice = number(feature['unitPrice']);
        const existing = aggregate.get(code);
        if (existing)
            existing.quantity += quantity;
        else
            aggregate.set(code, { quantity, unitPrice });
    }
    return aggregate;
}
function aggregatePrice(features) {
    let total = 0;
    for (const feature of features.values())
        total += feature.quantity * feature.unitPrice;
    return money(total);
}
function isWorkspace(value) {
    return value['configurations'] instanceof Map;
}
function object(value) {
    return typeof value === 'object' && value !== null ? value : {};
}
function array(value) {
    return Array.isArray(value) ? value : [];
}
function string(value) {
    return typeof value === 'string' ? value : '';
}
function number(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function firstNumber(...values) {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value))
            return value;
    }
    return 0;
}
function positiveQuantity(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
function money(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}
/** Browser groups truncate the inclusive-price remainder at two decimals. */
function browserMoney(value) {
    return Math.floor((value + Number.EPSILON) * 100) / 100;
}
/**
 * Logical Groups are client state on the website; they reach DCSC only as the export form's `groups` field.
 * Product lines move out of the default group by code; index is the position among siblings, with the
 * default group counted as the first top-level sibling. An imported workspace already holds its groups,
 * and the website counts them in front of the new top-level groups.
 */
export function applyLogicalGroups(base, logical, importedGroupCount = 0) {
    const [fallback, ...rest] = base;
    if (!fallback || rest.length > 0)
        throw new Error('Logical groups need exactly one default export group.');
    const names = new Set([fallback.name]);
    const siblings = new Map([[undefined, 1 + importedGroupCount]]);
    const claimed = new Set();
    const groups = logical.map(group => {
        if (names.has(group.name))
            throw new Error(`Group name "${group.name}" is duplicated or reserved.`);
        if (group.parent !== undefined && !names.has(group.parent))
            throw new Error(`Group "${group.name}" needs its parent "${group.parent}" listed before it.`);
        names.add(group.name);
        const index = siblings.get(group.parent) ?? 0;
        siblings.set(group.parent, index + 1);
        const products = group.products.flatMap(code => {
            if (claimed.has(code))
                throw new Error(`Product ${code} is assigned to more than one group.`);
            claimed.add(code);
            const lines = fallback.products.filter(product => product['code'] === code);
            if (lines.length === 0)
                throw new Error(`Product ${code} is not in this export.`);
            return lines.map(line => ({ ...line, groupId: group.name }));
        });
        return { name: group.name, ...(group.parent !== undefined ? { parent: group.parent } : {}), index, products };
    });
    return [{ ...fallback, products: fallback.products.filter(product => !claimed.has(String(product['code']))) }, ...groups];
}
//# sourceMappingURL=exportGroups.js.map