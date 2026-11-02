import { z } from 'zod';
import { parseResponse } from '../schemas/parse.js';
export const VerifyMandatorySoftwareInputSchema = z.object({
    mode: z.enum(['cto', 'lfo']).optional(),
    configuration: z.object({
        id: z.string().min(1, 'configuration.id is required'),
        code: z.string().min(1, 'configuration.code is required'),
        ctoCode: z.string().optional(),
        lfoCode: z.string().optional(),
        sections: z.array(z.unknown()),
    }).passthrough(),
});
const SubTabSchema = z.object({
    description: z.string(),
    label: z.string().optional(),
    value: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
const TabSchema = z.object({
    description: z.string(),
    introduce: z.string().optional(),
    subTabs: z.array(SubTabSchema).default([]),
}).passthrough();
export const MandatorySoftwareWireSchema = z.object({
    status: z.boolean(),
    tabs: z.array(TabSchema).nullable().optional().transform((val) => val ?? []),
    message: z.string().nullable().optional(),
}).passthrough();
/**
 * Validates whether mandatory software (Operating System, Hypervisor) has been selected
 * for a CTO or LFO configuration before proceeding to checkout/summary.
 * Endpoints:
 * - POST /cto/mandatory/sw/selection
 * - POST /lfo/mandatory/sw/selection
 */
export async function mandatoryVerifyConfig(http, ctx, input) {
    const validatedInput = VerifyMandatorySoftwareInputSchema.parse(input);
    const isLfo = validatedInput.mode === 'lfo';
    const endpoint = isLfo ? 'lfo_mandatory_sw_selection' : 'cto_mandatory_sw_selection';
    const path = isLfo ? '/lfo/mandatory/sw/selection' : '/cto/mandatory/sw/selection';
    const cfg = validatedInput.configuration;
    const payload = {
        ...cfg,
        ctoCode: isLfo ? cfg.ctoCode ?? cfg.code : cfg.code,
        ...(isLfo ? { lfoCode: cfg.lfoCode ?? cfg.code } : {}),
    };
    const res = await http.send({
        endpoint,
        method: 'POST',
        path,
        body: {
            kind: 'json',
            value: payload,
        },
        responseKind: 'json',
        timeoutClass: 'fast',
        ctx,
    });
    const parsed = parseResponse(MandatorySoftwareWireSchema, res.raw, {
        endpoint,
        corrId: ctx.corrId,
        requestId: res.requestId,
    });
    const showVerifyConfig = Boolean(parsed.status);
    const tabs = parsed.tabs.map((tab) => {
        let introduce = tab.introduce;
        if (showVerifyConfig) {
            if (tab.description === 'Operating System' && !introduce) {
                introduce = '(An OS is needed to run applications on a server)';
            }
            else if (tab.description === 'Hypervisor' && !introduce) {
                introduce = '(A Hypervisor is needed to create virtual machines)';
            }
        }
        const subTabs = tab.subTabs.map((subTab) => {
            if (showVerifyConfig) {
                return {
                    ...subTab,
                    label: subTab.label ?? subTab.description,
                    value: subTab.value ?? {
                        tabDescription: tab.description,
                        subTabDescription: subTab.description,
                    },
                };
            }
            return subTab;
        });
        return {
            ...tab,
            introduce,
            subTabs,
        };
    });
    const message = typeof parsed.message === 'string' ? parsed.message : null;
    return {
        showVerifyConfig,
        status: parsed.status,
        message,
        tabs,
    };
}
//# sourceMappingURL=mandatorySoftware.js.map