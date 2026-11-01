import type { RawConfiguration } from '../model/types.js';
import { buildRackConfigurations, type RackObject } from './rack.js';
import { type Obj, objectOrUndefined } from '../util/coerce.js';


export interface StoragePhysicalDeriveSplit {
  /** Partial ordinary/editable configuration response, safe to merge by configuration id. */
  configurations: RawConfiguration[];
  /**
   * Physical derived variants keyed by physical alias identity. The raw value deliberately keeps
   * DCSC's managed-template `id`; the object key supplies the physical identity and preserves the
   * distinction between an editable template and its rack-context derived result.
   */
  physicalConfigurations: Record<string, RawConfiguration>;
}

/**
 * Refreshes a placed storage alias from its rack-context derived raw while retaining envelope,
 * placement and future physical metadata. `response` is the enclosing auto-derive response; its
 * placement results supply the installations that DCSC adds before Back to Workspace.
 */
export function refreshStoragePhysicalFeatures(
  physical: RackObject,
  editableTemplate: RawConfiguration,
  response: unknown,
): RackObject {
  const physicalId = typeof physical.id === 'string' && physical.id.trim() ? physical.id : undefined;
  if (!physicalId) throw new Error('Storage physical item has no identity.');
  const derivedId = identity(editableTemplate, `Derived storage configuration for ${physicalId}`);
  const physicalCode = code(physical);
  const derivedCode = code(editableTemplate);
  if (physicalCode && derivedCode && physicalCode.toUpperCase() !== derivedCode.toUpperCase()) {
    throw new Error(`Storage physical item ${physicalId} changed product code from ${physicalCode} to ${derivedCode}.`);
  }
  if (!Array.isArray(editableTemplate.tabs)) {
    throw new Error(`Derived storage configuration ${derivedId} is missing its tabs array.`);
  }
  const targets = updateIds(editableTemplate, `Derived storage configuration ${derivedId}`);
  if (targets && (targets.length !== 1 || targets[0] !== derivedId)) {
    throw new Error(
      `Derived storage configuration ${derivedId} is a physical-price variant; ` +
      'rack features must be projected from the editable-template response.',
    );
  }

  // The SPA refreshes the rack DTO from the editable-template response. The separately returned
  // physical variant carries rack-derived prices, rails and manufacturing features, but those
  // remain commercial state and are not copied into the physical rack item's selected features.
  const enriched = structuredClone(editableTemplate);
  const wrapper = objectOrUndefined(response);
  const placementResults = Array.isArray(wrapper?.['placementResults'])
    ? wrapper['placementResults'].map(objectOrUndefined).filter((value): value is Obj => value !== undefined)
    : [];
  const workspaceId = typeof enriched['workspaceId'] === 'string' && enriched['workspaceId'].trim()
    ? enriched['workspaceId'] : derivedId;
  const matching = placementResults.filter(value => value['workspaceId'] === workspaceId);
  if (matching.length > 1) throw new Error(`Auto-derive returned multiple placement results for ${workspaceId}.`);
  if (matching[0]) applyPlacementResults(enriched, matching[0]);

  const compact = buildRackConfigurations([enriched])[0];
  if (!compact) throw new Error(`Cannot project derived storage features for ${physicalId}.`);
  const sectionTypes = selectedSectionTypes(enriched);
  const previousSections = Array.isArray(physical['features'])
    ? physical['features'].map(objectOrUndefined).filter((value): value is Obj => value !== undefined)
    : [];
  const features = compact.sections.map(section => {
    const previousSection = previousSections.find(value => value['name'] === section.name);
    const previousResults = Array.isArray(previousSection?.['results'])
      ? previousSection['results'].map(objectOrUndefined).filter((value): value is Obj => value !== undefined)
      : [];
    const results = section.features.map(feature => {
      const previous = previousResults.find(value => value['code'] === feature.code);
      const projected = structuredClone(feature) as unknown as Obj;
      const sectionType = sectionTypes.get(section.name);
      if (sectionType) projected['type'] = sectionType;
      if (previous && typeof previous['forAutoConnect'] === 'boolean') {
        projected['forAutoConnect'] = previous['forAutoConnect'];
      }
      return projected;
    });
    return { name: section.name, results };
  });
  return { ...structuredClone(physical), features };
}

/** The rack DTO uses the enclosing tab type, even when a service result says `type: service`. */
function selectedSectionTypes(configuration: RawConfiguration): Map<string, string> {
  const types = new Map<string, string>();
  for (const tab of configuration.tabs ?? []) {
    if (!tab || typeof tab !== 'object') continue;
    const tabObject = tab as Obj;
    const tabType = typeof tabObject['type'] === 'string' && tabObject['type'].trim()
      ? tabObject['type'] : undefined;
    const subTabs = Array.isArray(tabObject['subTabs']) ? tabObject['subTabs'] : [];
    for (const subTabValue of subTabs) {
      const subTab = objectOrUndefined(subTabValue);
      if (!subTab) continue;
      const sections = Array.isArray(subTab['sections']) ? subTab['sections'] : [];
      for (const sectionValue of sections) {
        const section = objectOrUndefined(sectionValue);
        const name = section && typeof section['name'] === 'string' ? section['name'] : undefined;
        if (name && tabType) types.set(name, tabType);
      }
    }
  }
  return types;
}

function applyPlacementResults(configuration: RawConfiguration, placement: Obj): void {
  const sections = [
    ...((configuration.tabs ?? []).flatMap(tab => (tab.subTabs ?? []).flatMap(subTab => subTab.sections ?? []))),
    ...(Array.isArray(configuration['unSelectableCharacters'])
      ? configuration['unSelectableCharacters'].map(objectOrUndefined).filter((value): value is Obj => value !== undefined)
      : []),
  ] as Obj[];
  const placements = Array.isArray(placement['sectionPlacement'])
    ? placement['sectionPlacement'].map(objectOrUndefined).filter((value): value is Obj => value !== undefined)
    : [];
  for (const sectionPlacement of placements) {
    const sectionName = sectionPlacement['sectionName'];
    if (typeof sectionName !== 'string') continue;
    const section = sections.find(value => value['name'] === sectionName);
    if (!section || !Array.isArray(section['results'])) continue;
    const results = section['results'].map(objectOrUndefined).filter((value): value is Obj => value !== undefined);
    const featurePlacements = Array.isArray(sectionPlacement['featurePlacement'])
      ? sectionPlacement['featurePlacement'].map(objectOrUndefined).filter((value): value is Obj => value !== undefined)
      : [];
    for (const featurePlacement of featurePlacements) {
      const result = results.find(value => value['code'] === featurePlacement['featureCode']);
      if (!result) continue;
      result['installations'] = Array.isArray(featurePlacement['installations'])
        ? structuredClone(featurePlacement['installations']) : [];
    }
  }
}

function identity(configuration: RawConfiguration, label: string): string {
  const id = typeof configuration.id === 'string' && configuration.id.trim() ? configuration.id : undefined;
  const alternate = typeof configuration['configurationId'] === 'string' &&
    configuration['configurationId'].trim() ? configuration['configurationId'] : undefined;
  if (id && alternate && id !== alternate) throw new Error(`${label} has conflicting id and configurationId values.`);
  if (!id && !alternate) throw new Error(`${label} has no configuration identity.`);
  return id ?? alternate!;
}

function code(configuration: RawConfiguration): string {
  for (const value of [configuration['code'], configuration.sliceCtoCode, configuration['ctoCode']]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function updateIds(configuration: RawConfiguration, label: string): string[] | undefined {
  const raw = configuration['updateConfigurationIds'];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error(`${label} has an invalid updateConfigurationIds list.`);
  }
  const ids = raw as string[];
  if (new Set(ids).size !== ids.length) throw new Error(`${label} repeats an update configuration identity.`);
  return ids;
}

/**
 * Separates `/ctos/autoDerive` configuration patches from managed-storage physical variants.
 *
 * DCSC uses the managed template id for both response kinds. An editable-template result targets
 * the template itself; a physical result targets one or more physical aliases through
 * `updateConfigurationIds`. Physical raws remain byte-for-byte response objects and are keyed by
 * alias rather than rewritten to pretend that each alias is an editable configuration.
 */
export function splitStoragePhysicalDerive(
  current: readonly RawConfiguration[],
  response: unknown,
  aliases: ReadonlyMap<string, string>,
): StoragePhysicalDeriveSplit {
  const currentById = new Map<string, RawConfiguration>();
  for (const configuration of current) {
    const id = identity(configuration, 'Current configuration');
    if (currentById.has(id)) throw new Error(`Duplicate current configuration identity: ${id}.`);
    currentById.set(id, configuration);
  }

  const aliasesByTemplate = new Map<string, Set<string>>();
  for (const [physicalId, templateId] of aliases) {
    if (!physicalId.trim() || !templateId.trim()) throw new Error('Storage physical alias identities must be nonempty.');
    if (physicalId === templateId) throw new Error(`Storage physical alias ${physicalId} cannot equal its template identity.`);
    if (!currentById.has(templateId)) {
      throw new Error(`Storage physical alias ${physicalId} references unknown template ${templateId}.`);
    }
    const members = aliasesByTemplate.get(templateId) ?? new Set<string>();
    members.add(physicalId);
    aliasesByTemplate.set(templateId, members);
  }

  const wrapper = objectOrUndefined(response);
  if (!wrapper || !Array.isArray(wrapper['configurations'])) {
    throw new Error('Auto-derive response is missing its configurations array.');
  }

  const configurations: RawConfiguration[] = [];
  const physicalConfigurations: Record<string, RawConfiguration> = {};
  const ordinaryIds = new Set<string>();
  for (const [index, value] of wrapper['configurations'].entries()) {
    const rawObject = objectOrUndefined(value);
    if (!rawObject) throw new Error(`Auto-derive configuration at index ${index} is not an object.`);
    const raw = rawObject as RawConfiguration;
    const id = identity(raw, `Auto-derive configuration at index ${index}`);
    const existing = currentById.get(id);
    if (!existing) throw new Error(`Auto-derive configuration has unknown id: ${id}.`);
    const existingCode = code(existing);
    const responseCode = code(raw);
    if (existingCode && responseCode && existingCode.toUpperCase() !== responseCode.toUpperCase()) {
      throw new Error(`Auto-derive configuration ${id} changed product code from ${existingCode} to ${responseCode}.`);
    }

    const targets = updateIds(raw, `Auto-derive configuration ${id}`);
    if (targets === undefined || (targets.length === 1 && targets[0] === id)) {
      if (ordinaryIds.has(id)) throw new Error(`Duplicate ordinary auto-derive configuration id: ${id}.`);
      ordinaryIds.add(id);
      configurations.push(structuredClone(raw));
      continue;
    }

    if (targets.includes(id)) {
      throw new Error(`Auto-derive configuration ${id} ambiguously targets both its template and physical aliases.`);
    }
    const knownAliases = aliasesByTemplate.get(id);
    if (!knownAliases) {
      throw new Error(`Auto-derive configuration ${id} targets physical identities but is not a managed storage template.`);
    }
    if (!Array.isArray(raw.tabs)) {
      throw new Error(`Auto-derive physical configuration ${id} is missing its tabs array.`);
    }
    for (const physicalId of targets) {
      const owner = aliases.get(physicalId);
      if (!owner) throw new Error(`Auto-derive configuration ${id} targets unknown physical identity ${physicalId}.`);
      if (owner !== id || !knownAliases.has(physicalId)) {
        throw new Error(`Auto-derive configuration ${id} targets physical identity ${physicalId} owned by template ${owner}.`);
      }
      if (physicalConfigurations[physicalId]) {
        throw new Error(`Physical storage identity ${physicalId} received multiple derived configurations.`);
      }
      physicalConfigurations[physicalId] = structuredClone(raw);
    }
  }

  return { configurations, physicalConfigurations };
}
