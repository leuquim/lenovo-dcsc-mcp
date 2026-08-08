import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Config } from '../config/schema.js';
import { logger } from '../http/trace.js';
import type { SessionStore } from './SessionStore.js';

/**
 * Durable sessions.
 *
 * An architect's design lives for days or weeks, not for one process lifetime,
 * and a rack layout is expensive to rebuild: every placement is a round trip to
 * DCSC. Keeping sessions only in memory meant a restart silently discarded all
 * of that, so the store is snapshotted to disk after every mutation and read
 * back on startup.
 *
 * The snapshot deliberately drops derived state — the feature index is rebuilt
 * from `raw` on load — and keeps only the most recent undo snapshots, because
 * the raw configuration tree is around 150 KB per configuration.
 */

const SNAPSHOT_VERSION = 1;
const MAX_SNAPSHOTS_PERSISTED = 3;

export function stateFile(config: Config): string {
  if (config.files.sessionFile) return config.files.sessionFile;
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  return join(base, 'lenovo-dcsc', 'sessions.json');
}

export function saveSessions(store: SessionStore, config: Config): void {
  if (!config.files.persistSessions) return;
  const path = stateFile(config);
  try {
    const payload = {
      version: SNAPSHOT_VERSION,
      savedAt: Date.now(),
      workspaces: store.listWorkspaces().map((ws) => ({
        id: ws.id,
        label: ws.label,
        locale: ws.locale,
        solution: ws.solution,
        validationMode: ws.validationMode,
        rackArea: ws.rackArea,
        rackSummaries: ws.rackSummaries,
        cables: ws.cables,
        floorItems: ws.floorItems,
        powerSelections: ws.powerSelections,
        revision: ws.revision,
        createdAt: ws.createdAt,
        lastAccessAt: ws.lastAccessAt,
        pricedAt: ws.pricedAt,
        configurations: [...ws.configurations.values()].map((s) => ({
          id: s.id,
          label: s.label,
          product: s.product,
          mode: s.mode,
          validationMode: s.validationMode,
          raw: s.raw,
          configurationId: s.configurationId,
          reduced: s.reduced,
          primed: s.primed,
          revision: s.revision,
          intents: s.intents,
          snapshots: s.snapshots.slice(-MAX_SNAPSHOTS_PERSISTED),
          createdAt: s.createdAt,
          lastAccessAt: s.lastAccessAt,
          pricedAt: s.pricedAt,
        })),
      })),
    };

    mkdirSync(dirname(path), { recursive: true });
    // Write-then-rename so a crash mid-write cannot leave a truncated file
    // that would fail to parse on the next start.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    // Persistence is a convenience; never let it take down a tool call.
    logger().warn(
      { err: err instanceof Error ? err.message : String(err), path },
      'Could not persist sessions',
    );
  }
}

export function loadSessions(store: SessionStore, config: Config): number {
  if (!config.files.persistSessions) return 0;
  const path = stateFile(config);
  try {
    const text = readFileSync(path, 'utf8');
    const payload = JSON.parse(text) as { version?: number; workspaces?: unknown[] };
    if (payload.version !== SNAPSHOT_VERSION || !Array.isArray(payload.workspaces)) return 0;
    return store.restore(payload.workspaces);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger().warn(
        { err: err instanceof Error ? err.message : String(err), path },
        'Could not load persisted sessions; starting empty',
      );
    }
    return 0;
  }
}
