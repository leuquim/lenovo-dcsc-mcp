export declare function inspectXconfigSource(xml: string): {
    isXconfig: boolean;
    savedCabling: boolean;
    savedFloor: boolean;
    sourceInspectionUnavailable?: never;
} | {
    isXconfig: boolean;
    savedCabling: boolean;
    savedFloor: boolean;
    sourceInspectionUnavailable: boolean;
};
/** Excel is sent intact to Lenovo; its contents are never reconstructed locally. */
export declare function prepareImportFile(content: string | Uint8Array, fileName?: string): {
    content: Buffer<ArrayBuffer>;
    fileName: string;
    solutionMode: undefined;
    source: undefined;
    contentType: string;
} | {
    content: string;
    fileName: string;
    solutionMode: string;
    contentType: string;
    source: {
        isXconfig: boolean;
        savedCabling: boolean;
        savedFloor: boolean;
        sourceInspectionUnavailable?: never;
        breakoutConnections: import("../util/coerce.js").Obj[];
    } | {
        isXconfig: boolean;
        savedCabling: boolean;
        savedFloor: boolean;
        sourceInspectionUnavailable: boolean;
        breakoutConnections: import("../util/coerce.js").Obj[];
    };
};
