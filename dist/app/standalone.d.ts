import { type ExportFileType } from '../domain/reduce.js';
import { type SoftwareCatalogPath, type PartLookupType, type ProductServiceState, type StandaloneSoftwareState } from '../domain/standalone.js';
import { type StandaloneHardwareState } from '../domain/standaloneHardware.js';
import { type ExportBundle } from '../files/artifactStore.js';
import type { RequestCtx } from '../http/request.js';
import type { WorkspaceSession } from '../model/session.js';
import type { Runtime } from './runtime.js';
/** Captured default choices in the standalone software export dialog. */
export declare const SOFTWARE_EXPORT_TYPES: ExportFileType[];
export type PartLookupItem = {
    code: string;
    description: string;
    type: string;
    nextAction: string;
};
export interface PartLookupArgs {
    keyword: string;
    mode: 'CTO' | 'LFO';
    types?: readonly PartLookupType[] | undefined;
    solutionMode?: string | undefined;
    expectedCatalogFingerprint?: string | undefined;
}
export interface SupplyStatusProjection {
    code: string;
    type: string;
    country: string;
    shippingStatus: unknown;
}
export declare function requireWorkspace(rt: Runtime, handle: string): WorkspaceSession;
export declare function hardwareState(workspace: WorkspaceSession): StandaloneHardwareState;
export declare function hardwareState(workspace: WorkspaceSession, required: false): StandaloneHardwareState | undefined;
export declare function softwareState(workspace: WorkspaceSession): StandaloneSoftwareState;
export declare function softwareState(workspace: WorkspaceSession, required: false): StandaloneSoftwareState | undefined;
export declare function serviceState(workspace: WorkspaceSession): ProductServiceState;
export declare function serviceState(workspace: WorkspaceSession, required: false): ProductServiceState | undefined;
export declare function lookupParts(rt: Runtime, args: PartLookupArgs): Promise<{
    ctx: RequestCtx;
    solution: {
        solutionMode: string;
        masterSlices: string[];
    };
    items: PartLookupItem[];
}>;
export declare function partSupplyStatus(rt: Runtime, ctx: RequestCtx, targetCode: string, type: string): Promise<SupplyStatusProjection>;
export declare function launchSoftware(rt: Runtime, args: {
    session?: string | undefined;
    solutionMode?: string | undefined;
    label?: string | undefined;
    replace: boolean;
    refresh: boolean;
    expectedRevision?: number | undefined;
}): Promise<{
    workspace: WorkspaceSession;
    state: StandaloneSoftwareState;
}>;
export declare function selectSoftware(rt: Runtime, args: {
    session: string;
    code: string;
    quantity: number;
    expectedRevision?: number | undefined;
}): Promise<WorkspaceSession>;
export declare function setSoftwareQuantity(rt: Runtime, args: {
    session: string;
    code: string;
    quantity: number;
    expectedRevision?: number | undefined;
}): Promise<WorkspaceSession>;
export declare function removeSoftware(rt: Runtime, args: {
    session: string;
    code: string;
    expectedRevision?: number | undefined;
}): Promise<WorkspaceSession>;
export declare function addHardware(rt: Runtime, args: {
    session?: string | undefined;
    code: string;
    quantity: number;
    solutionMode?: string | undefined;
    label?: string | undefined;
    expectedRevision?: number | undefined;
}): Promise<WorkspaceSession>;
export declare function setHardwareQuantity(rt: Runtime, args: {
    session: string;
    code: string;
    quantity: number;
    expectedRevision?: number | undefined;
}): Promise<WorkspaceSession>;
export declare function removeHardware(rt: Runtime, args: {
    session: string;
    code: string;
    expectedRevision?: number | undefined;
}): Promise<WorkspaceSession>;
export declare function launchServices(rt: Runtime, args: {
    productCode?: string | undefined;
    productQuantity: number;
    productDescription?: string | undefined;
    subCategory: string;
    session?: string | undefined;
    solutionMode?: string | undefined;
    label?: string | undefined;
    replace: boolean;
    refresh: boolean;
    expectedRevision?: number | undefined;
}): Promise<WorkspaceSession>;
export declare function selectService(rt: Runtime, args: {
    session: string;
    serviceCode: string;
    quantity: number;
    expectedRevision?: number | undefined;
}): Promise<WorkspaceSession>;
export declare function setServiceQuantity(rt: Runtime, args: {
    session: string;
    serviceCode?: string | undefined;
    quantity: number;
    expectedRevision?: number | undefined;
}): Promise<WorkspaceSession>;
export declare function setServiceProductQuantity(rt: Runtime, args: {
    session: string;
    quantity: number;
    expectedRevision?: number | undefined;
}): Promise<WorkspaceSession>;
export declare function removeService(rt: Runtime, args: {
    session: string;
    serviceCode?: string | undefined;
    expectedRevision?: number | undefined;
}): Promise<WorkspaceSession>;
export declare function exportStandaloneSoftwareArtifact(rt: Runtime, workspace: WorkspaceSession, fileName: string, options?: {
    fileTypes?: ExportFileType[] | undefined;
    image?: string | undefined;
}): Promise<ExportBundle & {
    contentDisposition: string | undefined;
}>;
export declare function exportProductServiceArtifact(rt: Runtime, workspace: WorkspaceSession, fileName: string): Promise<ExportBundle & {
    contentDisposition: string | undefined;
}>;
/** The Services page Export (one product's catalog) or Download Catalog (the country catalog) button. */
export declare function exportServiceCatalogArtifact(rt: Runtime, args: {
    productCode?: string | undefined;
    fileName: string;
}): Promise<ExportBundle & {
    contentDisposition: string | undefined;
}>;
export declare function pricingContext(country: string, currency: string): {
    country: string;
    currency: string;
    priceType: string;
    account: string;
};
export declare const BASKETS: readonly ['software', 'hardware', 'services'];
export type Basket = (typeof BASKETS)[number];
export declare const BASKET_ACTIONS: readonly ['select', 'setQuantity', 'remove', 'setProductQuantity'];
export type BasketAction = (typeof BASKET_ACTIONS)[number];
/** Baskets that hold content in the workspace. */
export declare function presentBaskets(workspace: WorkspaceSession): Basket[];
/** Compact inspection of one basket: selections, list prices and totals. */
export declare function basketView(workspace: WorkspaceSession, basket: Basket, page?: {
    offset?: number;
    limit?: number;
    query?: string;
}): {
    country: string;
    currency: string;
    priceType: string;
    account: string;
    session: string;
    revision: number;
    selections: {
        code: string;
        featureCode: string | undefined;
        description: string;
        quantity: number;
        unitPrice: number | undefined;
        totalPrice: number | undefined;
    }[];
    totalListPrice: number | undefined;
    priceIncomplete: boolean;
    hardwareConfigurations: number;
    note: string;
} | {
    country: string;
    currency: string;
    priceType: string;
    account: string;
    session: string;
    revision: number;
    catalogItems: number;
    selections: {
        id: string;
        code: string;
        description: string;
        quantity: number;
        unitPrice: number | undefined;
        totalPrice: number | undefined;
        path: SoftwareCatalogPath;
    }[];
    totalListPrice: number;
    priceIncomplete: boolean;
} | {
    country: string;
    currency: string;
    priceType: string;
    account: string;
    session: string;
    revision: number;
    catalogItems: number;
    totalListPrice: number;
    priceIncomplete: boolean;
    selections: {
        id: string;
        code: string;
        quantity: number;
        unitPrice: number | undefined;
        totalPrice: number | undefined;
    }[];
    selectedTotal: number;
    omittedSelections: number;
    compacted: boolean;
    note: string;
} | {
    country: string;
    currency: string;
    priceType: string;
    account: string;
    session: string;
    revision: number;
    product: {
        code: string;
        quantity: number;
        description?: string | undefined;
    };
    subCategory: string;
    selectionSemantics: string;
    selections: {
        code: string;
        quantity: number;
        description: string;
        type: string;
        characterName: string;
        section: string;
        sectionName: string;
    }[];
    summary: unknown;
    page: {
        offset: number;
        limit: number;
        totalInCurrentGraph: number;
        returned: number;
    };
    options: {
        code: string;
        description: string;
        type: string;
        characterName: string;
        unitPrice: number | undefined;
        preSelectedQuantity: number | undefined;
        section: string;
        sectionName: string;
        sectionDescription: string;
        next: {
            tool: string;
            arguments: {
                session: string;
                basket: string;
                action: string;
                code: string;
                quantity: number;
                expectedRevision: number;
            };
        };
    }[];
    next: {
        tool: string;
        arguments: Record<string, unknown>;
    } | undefined;
};
export declare function basketBrowse(rt: Runtime, args: {
    session: string;
    basket: 'software' | 'services';
    query?: string | undefined;
    tab?: string | undefined;
    subTab?: string | undefined;
    section?: string | undefined;
    subCategory?: string | undefined;
    offset?: number | undefined;
    limit?: number | undefined;
    path?: string[] | undefined;
    expectedCatalogFingerprint?: string | undefined;
}): Promise<Record<string, unknown> | {
    country: string;
    currency: string;
    priceType: string;
    account: string;
    session: string;
    revision: number;
    selections: {
        code: string;
        featureCode: string | undefined;
        description: string;
        quantity: number;
        unitPrice: number | undefined;
        totalPrice: number | undefined;
    }[];
    totalListPrice: number | undefined;
    priceIncomplete: boolean;
    hardwareConfigurations: number;
    note: string;
} | {
    country: string;
    currency: string;
    priceType: string;
    account: string;
    session: string;
    revision: number;
    catalogItems: number;
    selections: {
        id: string;
        code: string;
        description: string;
        quantity: number;
        unitPrice: number | undefined;
        totalPrice: number | undefined;
        path: SoftwareCatalogPath;
    }[];
    totalListPrice: number;
    priceIncomplete: boolean;
} | {
    country: string;
    currency: string;
    priceType: string;
    account: string;
    session: string;
    revision: number;
    catalogItems: number;
    totalListPrice: number;
    priceIncomplete: boolean;
    selections: {
        id: string;
        code: string;
        quantity: number;
        unitPrice: number | undefined;
        totalPrice: number | undefined;
    }[];
    selectedTotal: number;
    omittedSelections: number;
    compacted: boolean;
    note: string;
} | {
    country: string;
    currency: string;
    priceType: string;
    account: string;
    session: string;
    revision: number;
    product: {
        code: string;
        quantity: number;
        description?: string | undefined;
    };
    subCategory: string;
    selectionSemantics: string;
    selections: {
        code: string;
        quantity: number;
        description: string;
        type: string;
        characterName: string;
        section: string;
        sectionName: string;
    }[];
    summary: unknown;
    page: {
        offset: number;
        limit: number;
        totalInCurrentGraph: number;
        returned: number;
    };
    options: {
        code: string;
        description: string;
        type: string;
        characterName: string;
        unitPrice: number | undefined;
        preSelectedQuantity: number | undefined;
        section: string;
        sectionName: string;
        sectionDescription: string;
        next: {
            tool: string;
            arguments: {
                session: string;
                basket: string;
                action: string;
                code: string;
                quantity: number;
                expectedRevision: number;
            };
        };
    }[];
    next: {
        tool: string;
        arguments: Record<string, unknown>;
    } | undefined;
}>;
export declare function basketSet(rt: Runtime, args: {
    session?: string | undefined;
    basket: Basket;
    action: BasketAction;
    code?: string | undefined;
    quantity?: number | undefined;
    solutionMode?: string | undefined;
    label?: string | undefined;
    expectedRevision?: number | undefined;
}): Promise<{
    country: string;
    currency: string;
    priceType: string;
    account: string;
    basket: "hardware" | "services" | "software";
    session: string;
    revision: number;
    selections: {
        code: string;
        featureCode: string | undefined;
        description: string;
        quantity: number;
        unitPrice: number | undefined;
        totalPrice: number | undefined;
    }[];
    totalListPrice: number | undefined;
    priceIncomplete: boolean;
    hardwareConfigurations: number;
    note: string;
} | {
    country: string;
    currency: string;
    priceType: string;
    account: string;
    basket: "hardware" | "services" | "software";
    session: string;
    revision: number;
    catalogItems: number;
    selections: {
        id: string;
        code: string;
        description: string;
        quantity: number;
        unitPrice: number | undefined;
        totalPrice: number | undefined;
        path: SoftwareCatalogPath;
    }[];
    totalListPrice: number;
    priceIncomplete: boolean;
} | {
    country: string;
    currency: string;
    priceType: string;
    account: string;
    basket: "hardware" | "services" | "software";
    session: string;
    revision: number;
    catalogItems: number;
    totalListPrice: number;
    priceIncomplete: boolean;
    selections: {
        id: string;
        code: string;
        quantity: number;
        unitPrice: number | undefined;
        totalPrice: number | undefined;
    }[];
    selectedTotal: number;
    omittedSelections: number;
    compacted: boolean;
    note: string;
} | {
    country: string;
    currency: string;
    priceType: string;
    account: string;
    basket: "hardware" | "services" | "software";
    session: string;
    revision: number;
    product: {
        code: string;
        quantity: number;
        description?: string | undefined;
    };
    subCategory: string;
    selectionSemantics: string;
    selections: {
        code: string;
        quantity: number;
        description: string;
        type: string;
        characterName: string;
        section: string;
        sectionName: string;
    }[];
    summary: unknown;
    page: {
        offset: number;
        limit: number;
        totalInCurrentGraph: number;
        returned: number;
    };
    options: {
        code: string;
        description: string;
        type: string;
        characterName: string;
        unitPrice: number | undefined;
        preSelectedQuantity: number | undefined;
        section: string;
        sectionName: string;
        sectionDescription: string;
        next: {
            tool: string;
            arguments: {
                session: string;
                basket: string;
                action: string;
                code: string;
                quantity: number;
                expectedRevision: number;
            };
        };
    }[];
    next: {
        tool: string;
        arguments: Record<string, unknown>;
    } | undefined;
}>;
