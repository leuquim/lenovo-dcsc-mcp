import { describe, expect, it } from 'vitest';
import { parseCfxml } from '../src/domain/import.js';

const sampleCfxml = `<?xml version="1.0" encoding="UTF-8"?>
<CFXML>
  <CFData>
    <ProprietaryInformation>
      <Name>Configuration Type</Name>
      <Value>General Purpose</Value>
    </ProprietaryInformation>
    <ProductLineItem>
      <Quantity>8</Quantity>
      <ProductIdentification>
        <PartnerProductIdentification>
          <ProprietaryProductIdentifier>7DMK-CTO1WW</ProprietaryProductIdentifier>
          <ProductDescription>ThinkSystem SR680a V4</ProductDescription>
        </PartnerProductIdentification>
      </ProductIdentification>
      <ProductSubLineItem>
        <Quantity>2</Quantity>
        <ProductIdentification>
          <PartnerProductIdentification>
            <ProprietaryProductIdentifier>C5R3</ProprietaryProductIdentifier>
            <ProductDescription>Intel Xeon 6740P 48C 270W 2.1GHz Processor</ProductDescription>
            <ProductCharacter>PROCESSOR</ProductCharacter>
          </PartnerProductIdentification>
        </ProductIdentification>
      </ProductSubLineItem>
      <ProductSubLineItem>
        <Quantity>32</Quantity>
        <ProductIdentification>
          <PartnerProductIdentification>
            <ProprietaryProductIdentifier>C0TQ</ProprietaryProductIdentifier>
            <ProductDescription>ThinkSystem 64GB TruDDR5 6400MHz RDIMM</ProductDescription>
            <ProductCharacter>MEMORY</ProductCharacter>
          </PartnerProductIdentification>
        </ProductIdentification>
      </ProductSubLineItem>
    </ProductLineItem>
  </CFData>
</CFXML>`;

describe('parseCfxml', () => {
  it('parses valid CFXML into structured solution line items', () => {
    const result = parseCfxml(sampleCfxml);

    expect(result.solutionMode).toBe('General Purpose');
    expect(result.configurations.length).toBe(1);

    const first = result.configurations[0]!;
    expect(first.productCode).toBe('7DMKCTO1WW');
    expect(first.quantity).toBe(8);
    expect(first.selections.length).toBe(2);

    const cpu = first.selections.find((s) => s.code === 'C5R3');
    expect(cpu).toBeDefined();
    expect(cpu?.quantity).toBe(2);
    expect(cpu?.character).toBe('PROCESSOR');

    const mem = first.selections.find((s) => s.code === 'C0TQ');
    expect(mem).toBeDefined();
    expect(mem?.quantity).toBe(32);
  });

  it('throws helpful error on invalid XML or missing CFXML tag', () => {
    expect(() => parseCfxml('<invalid></invalid>')).toThrow('Invalid CFXML');
  });
});
