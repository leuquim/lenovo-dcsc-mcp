import { stageRackedCloneMultiple, type RackedClonePlacement,
  type StageRackedCloneMultipleOptions } from './physicalClone.js';
import { nonBlankString, type Obj, objectOrUndefined } from '../util/coerce.js';


export interface StageRackedCopyOptions extends Omit<StageRackedCloneMultipleOptions, 'cloneIds'> {
  copyId: string;
  /** Configuration name used by Copy when the physical rack item is intentionally unnamed. */
  sourceName?: string | undefined;
}

export interface StagedRackedCopy {
  rackArea: StageRackedCloneMultipleOptions['rackArea'];
  nonRackArea: StageRackedCloneMultipleOptions['nonRackArea'];
  cloneDependency: Record<string, string[]>;
  placement: RackedClonePlacement;
  copyName: string;
}

function sourceDependency(value: unknown, sourceId: string): { root: string; members: string[] } | undefined {
  const dependency = objectOrUndefined(value);
  if (!dependency) return undefined;
  const matches: Array<{ root: string; members: string[] }> = [];
  for (const [root, rawMembers] of Object.entries(dependency)) {
    if (!Array.isArray(rawMembers)) continue;
    const members = rawMembers.filter((member): member is string => typeof member === 'string');
    if (root === sourceId || members.includes(sourceId)) matches.push({ root, members });
  }
  if (matches.length > 1) throw new Error(`Copy source ${sourceId} belongs to multiple dependency groups.`);
  return matches[0];
}

/**
 * Stage the browser's distinct rack `Copy` action for one direct rack item.
 * A Copy gets an independent identity/name/dependency group; unlike Clone
 * Multiple it does not remain commercially linked to its source.
 */
export function stageRackedCopy(options: StageRackedCopyOptions): StagedRackedCopy {
  const sourceId = nonBlankString(options.sourceId);
  const copyId = nonBlankString(options.copyId);
  if (!sourceId) throw new Error('Racked copy sourceId is required.');
  if (!copyId) throw new Error('Racked copy copyId is required.');

  const existingGroup = sourceDependency(options.cloneDependency, sourceId);

  const staged = stageRackedCloneMultiple({
    rackArea: options.rackArea,
    nonRackArea: options.nonRackArea,
    sourceId,
    cloneIds: [copyId],
    cloneDependency: options.cloneDependency,
    ...(options.childCloneIds ? { childCloneIds: options.childCloneIds } : {}),
  });
  const placement = staged.placements[0];
  if (!placement) throw new Error('Racked copy did not produce a physical placement.');
  const rack = staged.rackArea.find(candidate => candidate['id'] === placement.rackId ||
    candidate['configurationId'] === placement.rackId);
  const items = Array.isArray(rack?.['rackItems']) ? rack['rackItems'] as Obj[] : [];
  const source = items.find(item => item['id'] === sourceId || item['configurationId'] === sourceId);
  const copy = items.find(item => item['id'] === copyId || item['configurationId'] === copyId);
  const sourceName = nonBlankString(options.sourceName) ?? nonBlankString(source?.['name']);
  if (!sourceName) {
    throw new Error(`Racked copy source ${sourceId} has no configuration name; fallback hardware-label naming is not captured.`);
  }
  if (!copy) throw new Error(`Racked copy ${copyId} was not found after staging.`);
  const copyName = `Copy_${sourceName}`;
  copy['name'] = copyName;

  // stageRackedCloneMultiple supplies the shared placement/identity checks.
  // Remove the temporary link to the copy without splitting the source group.
  staged.cloneDependency[existingGroup?.root ?? sourceId] = existingGroup ? [...existingGroup.members] : [sourceId];
  staged.cloneDependency[copyId] = [copyId];

  const sourceNodes = Array.isArray(source?.['nodes']) ? source['nodes'] as Obj[] : [];
  const copiedNodes = Array.isArray(copy['nodes']) ? copy['nodes'] as Obj[] : [];
  for (const node of sourceNodes) {
    const nodeId = nonBlankString(node['id']) ?? nonBlankString(node['configurationId']);
    if (!nodeId) throw new Error('Copy source node has no identity.');
    const group = sourceDependency(options.cloneDependency, nodeId);
    const childId = options.childCloneIds?.[copyId]?.[nodeId];
    const child = copiedNodes.find(n => n['id'] === childId || n['configurationId'] === childId);
    const name = nonBlankString(node['name']);
    if (!childId || !child || !name) throw new Error(`Copy source node ${nodeId} requires a mapped identity and configuration name.`);
    child['name'] = `Copy_${name}`;
    staged.cloneDependency[group?.root ?? nodeId] = group ? [...group.members] : [nodeId];
    staged.cloneDependency[childId] = [childId];
  }

  return {
    rackArea: staged.rackArea,
    nonRackArea: staged.nonRackArea,
    cloneDependency: staged.cloneDependency,
    placement,
    copyName,
  };
}
