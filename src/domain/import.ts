import { XMLParser } from 'fast-xml-parser';

export interface ParsedCfxmlItem {
  code: string;
  quantity: number;
  description?: string;
  character?: string;
}

export interface ParsedCfxmlConfiguration {
  productCode: string;
  solutionMode: string;
  quantity: number;
  description?: string;
  selections: ParsedCfxmlItem[];
}

export interface ParsedCfxmlSolution {
  solutionMode: string;
  configurations: ParsedCfxmlConfiguration[];
}

export function sanitiseProductCode(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/**
 * Parses Lenovo CFXML string into structured configuration product lines and feature selections.
 */
export function parseCfxml(xmlContent: string): ParsedCfxmlSolution {
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: true,
    trimValues: true,
  });

  const parsed = parser.parse(xmlContent);
  const cfData = parsed.CFXML?.CFData;
  if (!cfData) {
    throw new Error('Invalid CFXML: missing root <CFXML><CFData> element.');
  }

  let solutionMode = 'General Purpose';
  const propInfos = Array.isArray(cfData.ProprietaryInformation)
    ? cfData.ProprietaryInformation
    : cfData.ProprietaryInformation ? [cfData.ProprietaryInformation] : [];

  for (const info of propInfos) {
    if (info?.Name === 'Configuration Type' && typeof info.Value === 'string') {
      solutionMode = info.Value;
    }
  }

  const rawLineItems = Array.isArray(cfData.ProductLineItem)
    ? cfData.ProductLineItem
    : cfData.ProductLineItem ? [cfData.ProductLineItem] : [];

  const configurations: ParsedCfxmlConfiguration[] = [];

  for (const item of rawLineItems) {
    const partnerId = item.ProductIdentification?.PartnerProductIdentification;
    const rawCode = partnerId?.ProprietaryProductIdentifier ?? '';
    const code = sanitiseProductCode(String(rawCode));
    if (!code) continue;

    const quantity = Number(item.Quantity ?? 1);
    const description = partnerId?.ProductDescription ? String(partnerId.ProductDescription) : undefined;

    const rawSubItems = Array.isArray(item.ProductSubLineItem)
      ? item.ProductSubLineItem
      : item.ProductSubLineItem ? [item.ProductSubLineItem] : [];

    const selections: ParsedCfxmlItem[] = [];
    for (const sub of rawSubItems) {
      const subPartner = sub.ProductIdentification?.PartnerProductIdentification;
      const subCode = sanitiseProductCode(String(subPartner?.ProprietaryProductIdentifier ?? ''));
      if (!subCode) continue;

      const subQty = Number(sub.Quantity ?? 1);
      const subDesc = subPartner?.ProductDescription ? String(subPartner.ProductDescription) : undefined;
      const subChar = subPartner?.ProductCharacter ? String(subPartner.ProductCharacter) : undefined;

      selections.push({
        code: subCode,
        quantity: subQty,
        ...(subDesc !== undefined ? { description: subDesc } : {}),
        ...(subChar !== undefined ? { character: subChar } : {}),
      });
    }

    configurations.push({
      productCode: code,
      solutionMode,
      quantity,
      ...(description !== undefined ? { description } : {}),
      selections,
    });
  }

  if (configurations.length === 0) {
    throw new Error('Invalid CFXML: no valid ProductLineItem elements found.');
  }

  return { solutionMode, configurations };
}
