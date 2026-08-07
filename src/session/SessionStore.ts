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
  label?: string | undefined;
  locale: Locale;
  solution: SolutionContext;
  product: { code: string; description: string; type: string };
  mode: ConfigMode;
  validationMode: 'guided' | 'expert';

  /**
   * The verbatim payload from the last launch or mutation.
   *
   * Never normalised, never reconstructed. DCSC holds no server-side session
   * (launch returns id: null), so this object *is* the configuration and is
   * what must be posted back on every mutation. Replacing it with our own
   * schema would make the configuration unmutatable.
   */
  raw: RawConfiguration;

  /**
   * Client-generated configuration id (`US__<uuid>0`). DCSC has no server-side
   * session, so this identifier is ours and must stay stable for the life of
   * the configuration — mutation and export both key off it.
   */
  configurationId: string;

  /** The compact model actually posted back on mutation and export. */
  reduced: ReducedConfiguration;

  /**
   * Whether the priming autoDerive succeeded. An unprimed session is still
   * fully usable for browsing, pricing and the bill of materials; only
   * mutation depends on the derived sections.
   */
  primed: boolean;

  index: ConfigIndex;
  revision: number;
  intents: ConfigIntent[];
  /**
   * Ring buffer for undo. Snapshots capture `raw` AND `reduced` together:
   * restoring only `raw` would leave the model we post back on the next
   * mutation or export describing the *post-change* configuration while the
   * caller is shown the pre-change one — a silent divergence that would
   * produce a wrong quote.
   */
  snapshots: Array<{ revision: number; raw: RawConfiguration; reduced: ReducedConfiguration }>;
  createdAt: number;
  lastAccessAt: number;
  pricedAt: number;
}

const MAX_SNAPSHOTS = 10;

/** Serialises work per session; concurrent mutations would silently lose one. */
class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn, fn);
    // Keep the chain alive even when a caller rejects.
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
}

export class SessionStore {
  readonly #sessions = new Map<string, ConfigSession>();
  readonly #mutexes = new Map<string, Mutex>();

  constructor(private readonly maxSessions = 20) {}

  create(input: CreateSessionInput): ConfigSession {
    // An LFO launch has no `sliceCtoCode`; fall back to the reduced model so
    // session handles stay recognisable (sess_7DCE100GNA_… not sess_config_…).
    const code =
      input.reduced.lfoCode ?? input.raw.sliceCtoCode ?? input.reduced.sliceCtoCode ?? 'config';
    const id = `sess_${code}_${ulid().slice(-6).toLowerCase()}`;
    const now = Date.now();

    const session: ConfigSession = {
      id,
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

    this.#sessions.set(id, session);
    this.#evictIfNeeded();
    return session;
  }

  get(id: string): ConfigSession | undefined {
    const s = this.#sessions.get(id);
    if (s) s.lastAccessAt = Date.now();
    return s;
  }

  list(): ConfigSession[] {
    return [...this.#sessions.values()].sort((a, b) => b.lastAccessAt - a.lastAccessAt);
  }

  delete(id: string): boolean {
    this.#mutexes.delete(id);
    return this.#sessions.delete(id);
  }

  /** All mutations for a session serialise through here. */
  withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    let mutex = this.#mutexes.get(id);
    if (!mutex) {
      mutex = new Mutex();
      this.#mutexes.set(id, mutex);
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
    return true;
  }

  #evictIfNeeded(): void {
    if (this.#sessions.size <= this.maxSessions) return;
    const sorted = [...this.#sessions.values()].sort(
      (a, b) => a.lastAccessAt - b.lastAccessAt,
    );
    const excess = this.#sessions.size - this.maxSessions;
    for (let i = 0; i < excess; i += 1) {
      const victim = sorted[i];
      if (victim) this.delete(victim.id);
    }
  }
}
