import type { ConfigSession } from '../model/session.js';
import type { Runtime } from './runtime.js';
/** What DCSC's rules engine added, removed or substituted, plus its rule messages verbatim. */
export declare function explainConfiguration(session: ConfigSession, sinceRevision?: number): {
    ruleMessages: {
        severity: string;
        code?: string;
        section?: string;
        message: string;
    }[];
    note: string;
} | {
    added: import("../model/diff.js").PartChange[];
    removed: import("../model/diff.js").PartChange[];
    replaced: import("../model/diff.js").Replacement[];
    quantityChanged: import("../model/diff.js").PartChange[];
    price: {
        before: number | null;
        after: number | null;
        delta: number | null;
        currency: string;
    };
    constraints: import("../model/project.js").Constraint[];
    autoChanges: number;
    comparedFrom: number;
    comparedTo: number;
    requested: {
        section: string;
        code: string;
        quantity: number;
    }[];
    ruleMessages: {
        severity: string;
        code?: string;
        section?: string;
        message: string;
    }[];
    note: string;
};
export declare function configurationRuleVersions(rt: Runtime, ctoCode: string, tableCode?: string): Promise<{
    ctoCode: string;
    versions: string[];
    tableCode: string;
    ruleVersions: unknown;
}>;
