import type { RawConfiguration } from '../model/types.js';
import { type Obj } from '../util/coerce.js';
/** Observations, not a completeness verdict: one row cannot prove all ports are connected. */
export declare function cablingDiagnostics(configurations: readonly RawConfiguration[], state: Obj): {
    connectionCount: number;
    requestedNetworkCount: number;
    requestedNetworksWithoutConnections: number;
    unclassifiedConnections: number;
    connectionGraphStale: boolean;
    p2pDisabled: boolean;
    completeness: string;
    guidance: string;
    networks: {
        name: string;
        requested: boolean;
        storage: boolean;
        connectionCount: number;
        status: string;
    }[];
};
