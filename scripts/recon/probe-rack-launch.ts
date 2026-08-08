import { loadConfig } from '../../src/config/load.js';
import { fetchSolutionModes, toSolutionContext } from '../../src/domain/context.js';
import { DcscHttpClient, RequestBudget, type RequestCtx } from '../../src/http/request.js';
import { configureLogger, newCorrId } from '../../src/http/trace.js';

async function main(): Promise<void> {
  const config = loadConfig({ logLevel: 'error' });
  configureLogger('error');
  const http = new DcscHttpClient(config);
  const budget = new RequestBudget(25);
  const base = { corrId: newCorrId(), locale: config.locale, budget };
  const solution = toSolutionContext(await fetchSolutionModes(http, base), 'General Purpose');
  const ctx: RequestCtx = { ...base, solution };

  const CODE = '7D6DCTO1WW';
  console.log(`Testing launch for rack cabinet ${CODE}`);

  // Test 1: Standard launch
  try {
    const res1 = await http.send({
      endpoint: 'probe',
      method: 'POST',
      path: `/ctos/${CODE}/launch`,
      query: { hardwareOnly: false, controlExpressModal: false },
      body: { kind: 'json', value: {} },
      responseKind: 'json',
      ctx,
    });
    console.log(`SUCCESS standard /ctos/${CODE}/launch! Status ${res1.status}`);
    const raw = res1.raw as Record<string, unknown>;
    console.log('Keys:', Object.keys(raw));
    console.log('ctoCode:', raw.ctoCode ?? raw.sliceCtoCode);
  } catch (e: unknown) {
    const err = e as { status?: number; internal?: unknown };
    console.log(`Standard launch failed:`, err.status, String(err.internal ?? e).slice(0, 150));
  }

  // Test 2: Rack launch
  try {
    const res2 = await http.send({
      endpoint: 'probe',
      method: 'POST',
      path: `/ctos/racks/${CODE}/launch`,
      query: { hardwareOnly: false, controlExpressModal: false },
      body: { kind: 'json', value: {} },
      responseKind: 'json',
      ctx,
    });
    console.log(`SUCCESS rack /ctos/racks/${CODE}/launch! Status ${res2.status}`);
    const raw = res2.raw as Record<string, unknown>;
    console.log('Keys:', Object.keys(raw));
  } catch (e: unknown) {
    const err = e as { status?: number; internal?: unknown };
    console.log(`Rack launch failed:`, err.status, String(err.internal ?? e).slice(0, 150));
  }

  await http.close();
}

main().catch(console.error);
