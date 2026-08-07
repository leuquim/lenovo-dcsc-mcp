import { ulid } from 'ulid';

import type { ConfigMode } from '../config/constants.js';
import type { Locale, SolutionContext } from '../config/schema.js';
import type { ReducedConfiguration } from '../domain/reduce.js';
import { buildIndex, type ConfigIndex } from '../model/index.js';
import type { RawConfiguration } from '../model/types.js';

export interface ConfigIntent {
  at: number;
  changes: Array<{ section: string; code: string; quantity: number }>;
}

export interface ConfigSession {
  id: string;
  workspaceId: string;
  label?: string | undefined;
  locale: Locale;
  solution: SolutionContext;
  product: { code: string; description: string; type: string };
  mode: ConfigMode;
  validationMode: 'guided' | 'expert';

  raw: RawConfiguration;
  configurationId: string;
  reduced: ReducedConfiguration;
  primed: boolean;
  index: ConfigIndex;
  revision: number;
  intents: ConfigIntent[];
  snapshots: Array<{ revision: number; raw: RawConfiguration; reduced: ReducedConfiguration }>;
  createdAt: number;
  lastAccessAt: number;
  pricedAt: number;
}

export interface RackPlacement {
  id: string;
  code: string;
  description: string;
  uheight: number;
  position: number;
  items: Array<{
    configId: string;
    code: string;
    position: number;
    height: number;
  }>;
}

export interface CableLink {
  id: string;
  fromConfigId: string;
  fromPort: string;
  toConfigId: string;
  toPort: string;
  cableCode?: string;
  description?: string;
}

export interface WorkspaceSession {
  id: string;
  label?: string | undefined;
  locale: Locale;
  solution: SolutionContext;
  validationMode: 'guided' | 'expert';
  configurations: Map<string, ConfigSession>;
  racks: Map<string, RackPlacement>;
  cables: CableLink[];
  revision: number;
  createdAt: number;
  lastAccessAt: number;
  pricedAt: number;
}

/** Serialises work per session/workspace; concurrent mutations would silently lose one. */
class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn, fn);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export interface CreateSessionInput {
  locale: Locale;
  solution: SolutionContext;
  mode: ConfigMode;
  validationMode?: 'guided' | 'expert';
  raw: RawConfiguration;
  configurationId: string;
  reduced: ReducedConfiguration;
  primed: boolean;
  label?: string | undefined;
  workspaceId?: string | undefined;
}

export class SessionStore {
  readonly #workspaces = new Map<string, WorkspaceSession>();
  readonly #sessions = new Map<string, ConfigSession>();
  readonly #mutexes = new Map<string, Mutex>();

  constructor(private readonly maxSessions = 20) {}

  create(input: CreateSessionInput): ConfigSession {
    const code =
      input.reduced.lfoCode ?? input.raw.sliceCtoCode ?? input.reduced.sliceCtoCode ?? 'config';
    const configId = `sess_${code}_${ulid().slice(-6).toLowerCase()}`;
    const now = Date.now();

    let workspace: WorkspaceSession;
    const existing = input.workspaceId ? this.getWorkspace(input.workspaceId) : undefined;
    if (existing) {
      workspace = existing;
    } else {
      const wsId = input.workspaceId ?? `ws_${ulid().slice(-8).toLowerCase()}`;
      workspace = {
        id: wsId,
        ...(input.label !== undefined ? { label: input.label } : {}),
        locale: input.locale,
        solution: input.solution,
        validationMode: input.validationMode ?? 'guided',
        configurations: new Map(),
        racks: new Map(),
        cables: [],
        revision: 1,
        createdAt: now,
        lastAccessAt: now,
        pricedAt: now,
      };
      this.#workspaces.set(wsId, workspace);
    }

    const session: ConfigSession = {
      id: configId,
      workspaceId: workspace.id,
      ...(input.label !== undefined ? { label: input.label } : {}),
      locale: input.locale,
      solution: input.solution,
      product: {
        code,
        description: input.raw.description ?? '',
        type: input.raw.type ?? 'unknown',
      },
      mode: input.mode,
      validationMode: input.validationMode ?? 'guided',
      raw: input.raw,
      configurationId: input.configurationId,
      reduced: input.reduced,
      primed: input.primed,
      index: buildIndex(input.raw),
      revision: 1,
      intents: [],
      snapshots: [],
      createdAt: now,
      lastAccessAt: now,
      pricedAt: now,
    };

    workspace.configurations.set(configId, session);
    workspace.lastAccessAt = now;
    this.#sessions.set(configId, session);

    this.#evictIfNeeded();
    return session;
  }

  get(id: string): ConfigSession | undefined {
    const s = this.#sessions.get(id);
    if (s) {
      s.lastAccessAt = Date.now();
      const ws = this.#workspaces.get(s.workspaceId);
      if (ws) ws.lastAccessAt = Date.now();
      return s;
    }
    // If passed a workspaceId directly, return its first configuration if available
    const ws = this.#workspaces.get(id);
    if (ws) {
      ws.lastAccessAt = Date.now();
      return [...ws.configurations.values()][0];
    }
    return undefined;
  }

  getWorkspace(id: string): WorkspaceSession | undefined {
    // Can lookup by workspaceId or configId
    const ws = this.#workspaces.get(id);
    if (ws) {
      ws.lastAccessAt = Date.now();
      return ws;
    }
    const s = this.#sessions.get(id);
    if (s) {
      const parent = this.#workspaces.get(s.workspaceId);
      if (parent) {
        parent.lastAccessAt = Date.now();
        return parent;
      }
    }
    return undefined;
  }

  list(): ConfigSession[] {
    return [...this.#sessions.values()].sort((a, b) => b.lastAccessAt - a.lastAccessAt);
  }

  listWorkspaces(): WorkspaceSession[] {
    return [...this.#workspaces.values()].sort((a, b) => b.lastAccessAt - a.lastAccessAt);
  }

  delete(id: string): boolean {
    this.#mutexes.delete(id);
    const s = this.#sessions.get(id);
    if (s) {
      const ws = this.#workspaces.get(s.workspaceId);
      if (ws) {
        ws.configurations.delete(id);
        if (ws.configurations.size === 0) {
          this.#workspaces.delete(ws.id);
        }
      }
      return this.#sessions.delete(id);
    }
    const ws = this.#workspaces.get(id);
    if (ws) {
      for (const configId of ws.configurations.keys()) {
        this.#sessions.delete(configId);
      }
      return this.#workspaces.delete(id);
    }
    return false;
  }

  /** All mutations for a session or workspace serialise through here. */
  withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const ws = this.getWorkspace(id);
    const lockId = ws?.id ?? id;
    let mutex = this.#mutexes.get(lockId);
    if (!mutex) {
      mutex = new Mutex();
      this.#mutexes.set(lockId, mutex);
    }
    return mutex.run(fn);
  }

  /** Commits a new raw payload, bumping the revision and rebuilding the index. */
  commit(
    session: ConfigSession,
    raw: RawConfiguration,
    reduced: ReducedConfiguration,
    intent?: ConfigIntent,
  ): ConfigSession {
    const MAX_SNAPSHOTS = 10;
    session.snapshots.push({
      revision: session.revision,
      raw: session.raw,
      reduced: session.reduced,
    });
    if (session.snapshots.length > MAX_SNAPSHOTS) session.snapshots.shift();

    session.raw = raw;
    session.reduced = reduced;
    session.index = buildIndex(raw);
    session.revision += 1;
    session.pricedAt = Date.now();
    session.lastAccessAt = Date.now();
    if (intent) session.intents.push(intent);

    const ws = this.#workspaces.get(session.workspaceId);
    if (ws) {
      ws.revision += 1;
      ws.pricedAt = Date.now();
      ws.lastAccessAt = Date.now();
    }

    return session;
  }

  /** Restores the previous snapshot. Returns false when there is nothing to undo. */
  undo(session: ConfigSession): boolean {
    const prev = session.snapshots.pop();
    if (!prev) return false;
    session.raw = prev.raw;
    session.reduced = prev.reduced;
    session.index = buildIndex(prev.raw);
    session.revision += 1;
    session.lastAccessAt = Date.now();
    if (session.intents.length > 0) session.intents.pop();

    const ws = this.#workspaces.get(session.workspaceId);
    if (ws) {
      ws.revision += 1;
      ws.lastAccessAt = Date.now();
    }
    return true;
  }

  addRack(
    workspaceId: string,
    rackCode: string,
    description = 'Rack Enclosure',
    uheight = 42,
    position = 1,
  ): RackPlacement {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) throw new Error(`Workspace ${workspaceId} not found`);
    const rackId = `rack_${ulid().slice(-6).toLowerCase()}`;
    const rack: RackPlacement = {
      id: rackId,
      code: rackCode,
      description,
      uheight,
      position,
      items: [],
    };
    ws.racks.set(rackId, rack);
    ws.lastAccessAt = Date.now();
    return rack;
  }

  placeInRack(
    workspaceId: string,
    configId: string,
    rackId: string,
    uPosition: number,
    height = 1,
  ): boolean {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return false;
    const rack = ws.racks.get(rackId);
    if (!rack) return false;
    const session = ws.configurations.get(configId);
    if (!session) return false;

    // Remove existing placement if any
    for (const r of ws.racks.values()) {
      r.items = r.items.filter((item) => item.configId !== configId);
    }

    rack.items.push({
      configId,
      code: session.product.code,
      position: uPosition,
      height,
    });
    ws.lastAccessAt = Date.now();
    return true;
  }

  addCabling(workspaceId: string, cable: Omit<CableLink, 'id'>): CableLink {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) throw new Error(`Workspace ${workspaceId} not found`);
    const link: CableLink = {
      id: `cable_${ulid().slice(-6).toLowerCase()}`,
      ...cable,
    };
    ws.cables.push(link);
    ws.lastAccessAt = Date.now();
    return link;
  }

  #evictIfNeeded(): void {
    if (this.#workspaces.size <= this.maxSessions) return;
    const sorted = [...this.#workspaces.values()].sort(
      (a, b) => a.lastAccessAt - b.lastAccessAt,
    );
    const excess = this.#workspaces.size - this.maxSessions;
    for (let i = 0; i < excess; i += 1) {
      const victim = sorted[i];
      if (victim) this.delete(victim.id);
    }
  }
}
