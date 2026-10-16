import { stageRackedCloneMultiple, type RackedClonePlacement,
  type StageRackedCloneMultipleOptions } from './physicalClone.js';

type Obj = Record<string, unknown>;

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

function object(value: unknown): Obj | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Obj
    : undefined;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function sourceDependency(value: unknown, sourceId: string): { root: string; members: string[] } | undefined {
  const dependency = object(value);
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
  const sourceId = nonempty(options.sourceId);
  const copyId = nonempty(options.copyId);
  if (!sourceId) throw new Error('Racked copy sourceId is required.');
  if (!copyId) throw new Error('Racked copy copyId is required.');

  const existingGroup = sourceDependency(options.cloneDependency, sourceId);
  if (existingGroup && (existingGroup.root !== sourceId ||
      new Set(existingGroup.members).size !== 1 || existingGroup.members[0] !== sourceId)) {
    throw new Error(`Copy source ${sourceId} is linked by Clone Multiple; linked Copy semantics are not captured.`);
  }

  const staged = stageRackedCloneMultiple({
    rackArea: options.rackArea,
    nonRackArea: options.nonRackArea,
    sourceId,
    cloneIds: [copyId],
    cloneDependency: options.cloneDependency,
  });
  const placement = staged.placements[0];
  if (!placement) throw new Error('Racked copy did not produce a physical placement.');
  const rack = staged.rackArea.find(candidate => candidate['id'] === placement.rackId ||
    candidate['configurationId'] === placement.rackId);
  const items = Array.isArray(rack?.['rackItems']) ? rack['rackItems'] as Obj[] : [];
  const source = items.find(item => item['id'] === sourceId || item['configurationId'] === sourceId);
  const copy = items.find(item => item['id'] === copyId || item['configurationId'] === copyId);
  const sourceName = nonempty(options.sourceName) ?? nonempty(source?.['name']);
  if (!sourceName) {
    throw new Error(`Racked copy source ${sourceId} has no configuration name; fallback hardware-label naming is not captured.`);
  }
  if (!copy) throw new Error(`Racked copy ${copyId} was not found after staging.`);
  const copyName = `Copy_${sourceName}`;
  copy['name'] = copyName;

  // stageRackedCloneMultiple supplies the shared placement/identity checks.
  // Copy then breaks the temporary linked group into browser-authoritative
  // singleton commercial identities.
  staged.cloneDependency[sourceId] = [sourceId];
  staged.cloneDependency[copyId] = [copyId];

  return {
    rackArea: staged.rackArea,
    nonRackArea: staged.nonRackArea,
    cloneDependency: staged.cloneDependency,
    placement,
    copyName,
  };
}
