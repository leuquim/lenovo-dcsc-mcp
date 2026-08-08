import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import type { RawConfiguration } from '../model/types.js';
import type { CableLink } from '../session/SessionStore.js';
import { DEFAULT_FLOOR_PREFERENCE } from './floor.js';
import type { RackObject } from './rack.js';

/**
 * Cabling, backed by DCSC's auto-connect service where possible.
 *
 * Manual port-to-port links are SPA-local (the web UI stores them in Redux
 * without a round trip). Real connectivity is produced by POST /auto_connect,
 * which returns `connections` plus a corrected rackArea. We take that
 * response as truth and replace any previous local cable list.
 */

export interface ConnectionSummary {
  id: string;
  fromId?: string | undefined;
  toId?: string | undefined;
  fromPort?: string | undefined;
  toPort?: string | undefined;
  cableCode?: string | undefined;
  description?: string | undefined;
  raw: Record<string, unknown>;
}

export interface AutoConnectResult {
  connections: ConnectionSummary[];
  /** Mapped into the workspace cable list for export. */
  cables: CableLink[];
  rawRackArea: RackObject[];
  rawNonRackArea: RackObject[];
  /** Messages DCSC attached to racks (code 102 and similar). */
  messages: Array<{ rackId: string; messages: string[] }>;
}

type Obj = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * Runs DCSC auto-connect against the current workspace layout.
 *
 * The SPA posts a fuller body (cluster/power preference, switch map). The
 * minimal shape — rackArea, nonRackArea, configurations — is enough for a
 * 200 and is what we use; empty connections are a valid answer when the
 * layout has nothing to cable (single node, no switch).
 */
export async function autoConnect(
  http: DcscHttpClient,
  ctx: RequestCtx,
  payload: {
    rackArea: RackObject[];
    nonRackArea?: RackObject[];
    configurations: RawConfiguration[];
    floorItems?: Array<{ id: string; rackId: string; x: number; y: number }>;
  },
): Promise<AutoConnectResult> {
  if (payload.rackArea.length === 0 && (payload.nonRackArea?.length ?? 0) === 0) {
    throw new Error(
      'Nothing to cable: the workspace has no racks or non-rack items. ' +
        'Add a rack with dcsc_add_rack and place products with dcsc_place_in_rack first.',
    );
  }

  const cloneDependency: Record<string, string[]> = {};
  for (const c of payload.configurations) {
    const id = str(c['id']) ?? str((c as Obj)['configurationId']);
    if (id) cloneDependency[id] = [id];
  }

  const res = await http.send({
    endpoint: 'auto_connect',
    method: 'POST',
    path: '/auto_connect',
    body: {
      kind: 'json',
      value: {
        rackArea: payload.rackArea,
        nonRackArea: payload.nonRackArea ?? [],
        configurations: payload.configurations,
        clusterPreference: [],
        floorPreference: DEFAULT_FLOOR_PREFERENCE,
        powerPreference: [],
        floorItems: payload.floorItems ?? [],
        cloneRackMapping: {},
        storageConnectionNetworks: [],
        switchMap: [],
        cloneDependency,
      },
    },
    responseKind: 'json',
    timeoutClass: 'heavy',
    ctx,
  });

  const raw = res.raw as {
    rackArea?: RackObject[] | null;
    nonRackArea?: RackObject[] | null;
    connections?: unknown[] | null;
  };

  const connections = (raw.connections ?? []).map((c, i) => summariseConnection(c, i));
  const cables = connections.map(toCableLink);
  const rackArea = raw.rackArea ?? payload.rackArea;
  const messages = extractAutoConnectMessages(rackArea);

  return {
    connections,
    cables,
    rawRackArea: rackArea,
    rawNonRackArea: raw.nonRackArea ?? [],
    messages,
  };
}

function summariseConnection(value: unknown, index: number): ConnectionSummary {
  const o = (typeof value === 'object' && value !== null ? value : {}) as Obj;
  const fromId =
    str(o['fromId']) ?? str(o['sourceId']) ?? str(o['from']) ?? str(o['source']);
  const toId =
    str(o['toId']) ?? str(o['targetId']) ?? str(o['to']) ?? str(o['destination']);
  const fromPort =
    str(o['fromPort']) ?? str(o['sourcePort']) ?? str(o['fromPortName']);
  const toPort =
    str(o['toPort']) ?? str(o['targetPort']) ?? str(o['toPortName']);
  const cableCode =
    str(o['cableCode']) ?? str(o['cablePart']) ?? str(o['cableType']) ?? str(o['code']);
  const description = str(o['description']) ?? str(o['cableType']);
  const id = str(o['id']) ?? `conn_${index}`;

  return {
    id,
    fromId,
    toId,
    fromPort,
    toPort,
    cableCode,
    description,
    raw: o,
  };
}

function toCableLink(c: ConnectionSummary): CableLink {
  return {
    id: c.id,
    fromConfigId: c.fromId ?? '',
    fromPort: c.fromPort ?? '',
    toConfigId: c.toId ?? '',
    toPort: c.toPort ?? '',
    ...(c.cableCode !== undefined ? { cableCode: c.cableCode } : {}),
    ...(c.description !== undefined ? { description: c.description } : {}),
  };
}

/** DCSC tags auto-connect diagnostics as error code "102" on the rack. */
function extractAutoConnectMessages(
  rackArea: RackObject[],
): Array<{ rackId: string; messages: string[] }> {
  const out: Array<{ rackId: string; messages: string[] }> = [];
  for (const rack of rackArea) {
    const errors = rack['errors'];
    if (!Array.isArray(errors)) continue;
    const messages = errors
      .filter((e) => {
        if (typeof e !== 'object' || e === null) return false;
        return String((e as Obj)['code'] ?? '') === '102';
      })
      .map((e) => String((e as Obj)['message'] ?? ''))
      .filter(Boolean);
    if (messages.length > 0) {
      out.push({ rackId: String(rack['id'] ?? ''), messages });
    }
  }
  return out;
}
