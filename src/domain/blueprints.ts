/**
 * Curated starting points for AI factory work.
 *
 * Architects do not start from a blank configurator; they start from a
 * reference architecture and adjust. Each entry here is a product code that has
 * been verified to launch, price, export and re-import cleanly, together with
 * the solution mode it actually belongs to — which is not always the one you
 * would guess (SR685a V3 is General Purpose only).
 */

export interface Blueprint {
  id: string;
  name: string;
  productCode: string;
  /** The mode whose catalog contains this model. Launching elsewhere breaks import. */
  solutionMode: string;
  accelerator: string;
  cooling: 'air' | 'direct water';
  summary: string;
  /** Approximate list price in USD as verified on the date below. */
  verifiedListPriceUsd: number;
  verifiedOn: string;
}

export const BLUEPRINTS: Blueprint[] = [
  {
    id: 'b200-sxm-air',
    name: 'NVIDIA B200 8-GPU AI Enterprise Node',
    productCode: '7DM9CTO1WW',
    solutionMode: 'HPC and AI - Systems',
    accelerator: 'NVIDIA HGX B200 180GB 8-GPU',
    cooling: 'air',
    summary:
      'ThinkSystem SR680a V3, dual Intel Xeon Platinum, 8x B200 SXM on an HGX baseboard. ' +
      '8U air-cooled, the general-purpose AI training and inference node.',
    verifiedListPriceUsd: 953271.51,
    verifiedOn: '2026-08-08',
  },
  {
    id: 'b200-hdx-dwc',
    name: 'Liquid-Cooled B200 8-GPU Supernode',
    productCode: '7DJ5CTO1WW',
    solutionMode: 'HPC and AI - Systems',
    accelerator: 'NVIDIA HGX B200 180GB 8-GPU liquid-cooled',
    cooling: 'direct water',
    summary:
      'ThinkSystem SR780a V3 with direct water cooling. Chosen where rack power density or ' +
      'room cooling makes an air-cooled 8-GPU node impractical.',
    verifiedListPriceUsd: 980719.51,
    verifiedOn: '2026-08-08',
  },
  {
    id: 'mi300x-epyc',
    name: 'AMD EPYC + MI300X 8-GPU Node',
    productCode: '7DHCCTO1WW',
    // Verified: this model is absent from the HPC and AI catalog entirely.
    solutionMode: 'General Purpose',
    accelerator: 'AMD Instinct MI300X 192GB 8-GPU',
    cooling: 'air',
    summary:
      'ThinkSystem SR685a V3, dual AMD EPYC with an MI300X 8-GPU board. The non-NVIDIA ' +
      'accelerator option, typically for inference and memory-bound workloads.',
    verifiedListPriceUsd: 668234.01,
    verifiedOn: '2026-08-08',
  },
  {
    id: 'gb300-nvl72-tray',
    name: 'Grace Blackwell GB300 NVL72 Compute Tray',
    productCode: '7DLZCTO2WW',
    solutionMode: 'HPC and AI - Systems',
    accelerator: 'NVIDIA GB300 4-GPU Grace Blackwell',
    cooling: 'direct water',
    summary:
      '1U direct-water-cooled compute tray for MGX rack-scale architectures. The building ' +
      'block of an NVL72 rack; size these against the MGX rack (7DJVCTO2WW), not a standard cabinet.',
    verifiedListPriceUsd: 452860.5,
    verifiedOn: '2026-08-08',
  },
];

export function findBlueprint(idOrCode: string): Blueprint | undefined {
  const needle = idOrCode.toLowerCase();
  return BLUEPRINTS.find(
    (b) => b.id.toLowerCase() === needle || b.productCode.toLowerCase() === needle,
  );
}
