import { z } from 'zod';
import type { DcscHttpClient, RequestCtx } from '../http/request.js';

export const CfxmlValidationInputSchema = z.object({
  cfxmlContent: z.string().min(1, 'cfxmlContent cannot be empty'),
  filename: z.string().optional(),
});
export type CfxmlValidationInput = z.infer<typeof CfxmlValidationInputSchema>;

export const CfxmlValidationResponseSchema = z
  .object({
    url: z.string().nullable().optional(),
    message: z.string().nullable().optional(),
    success: z.boolean().optional(),
  })
  .passthrough();
export type CfxmlValidationResponse = z.infer<typeof CfxmlValidationResponseSchema>;

/**
 * Validates external CFXML configuration against DCSC's ecomm validation controller.
 *
 * Upstream route: POST /api/ecomm/cfxml_validation
 * Multipart form upload with cfxmlFile payload.
 */
export async function validateCfxml(
  http: DcscHttpClient,
  ctx: RequestCtx,
  input: CfxmlValidationInput,
): Promise<CfxmlValidationResponse> {
  const filename = input.filename ?? 'config.xml';
  const response = await http.send({
    endpoint: 'ecomm.cfxmlValidation',
    method: 'POST',
    path: '/ecomm/cfxml_validation',
    body: {
      kind: 'multipart',
      parts: [
        {
          name: 'cfxmlFile',
          filename,
          contentType: 'application/xml',
          content: Buffer.from(input.cfxmlContent, 'utf8'),
        },
      ],
    },
    responseKind: 'json',
    timeoutClass: 'interactive',
    requiresSolution: false,
    ctx,
  });

  return CfxmlValidationResponseSchema.parse(response.raw);
}
