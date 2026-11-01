import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { projectJsonPage } from '../model/pagedJson.js';
import type { DcscService } from './service.js';
import { guard, withToolSupport } from './toolSupport.js';
import { type Obj, objectOrEmpty } from '../util/coerce.js';


const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value, null, 2));

function clipText(value: string, limit: number): { value: string; truncated: boolean } {
  const characters = [...value];
  return characters.length <= limit
    ? { value, truncated: false }
    : { value: `${characters.slice(0, limit).join('')}…`, truncated: true };
}

function messagePreview(value: unknown): Obj {
  const source = objectOrEmpty(value);
  const message = typeof source['message'] === 'string' ? source.message : '';
  const clip = (candidate: unknown, limit: number): unknown => {
    if (typeof candidate !== 'string') return candidate;
    return clipText(candidate, limit).value;
  };
  const clippedMessage = clipText(message, 280);
  return {
    ...Object.fromEntries(['severity', 'code', 'section', 'configurationId', 'sourcePath']
      .filter(key => source[key] !== undefined).map(key => [key, clip(source[key], 160)])),
    message: clippedMessage.value,
    ...(clippedMessage.truncated ? { messageTruncated: true } : {}),
  };
}

/** Keeps ordinary validation results intact and makes oversized reports losslessly navigable. */
export function projectValidationToolResult(full: Obj, options: {
  session: string;
  jobId: string;
  maxBytes?: number | undefined;
}): Obj {
  const maxBytes = options.maxBytes ?? 7_500;
  if (jsonBytes(full) <= Math.min(7_000, maxBytes)) return full;

  const messages = Array.isArray(full['messages']) ? full.messages : [];
  const localDiagnostics = Array.isArray(full['localDiagnostics']) ? full.localDiagnostics : [];
  const headroom = Array.isArray(full['headroom']) ? full.headroom : [];
  const inspect = (path: string[]) => ({
    tool: 'dcsc_validation_jobs',
    arguments: { session: options.session, jobId: options.jobId, path, offset: 0, limit: 20 },
  });
  const pages: Obj = {
    savedJob: { inspect: inspect([]) },
    messages: { total: messages.length, inspect: inspect(['report', 'messages']) },
    localDiagnostics: { total: localDiagnostics.length, inspect: inspect(['projection', 'localDiagnostics']) },
    headroom: { total: headroom.length, inspect: inspect(['projection', 'headroom']) },
  };
  const headroomSummary = headroom.slice(0, 3).map(value => {
    const entry = objectOrEmpty(value);
    return {
      configuration: entry['configuration'],
      productCode: entry['productCode'],
      constraintCount: Array.isArray(entry['constraints']) ? entry.constraints.length : 0,
      breached: Array.isArray(entry['breached']) ? entry.breached : [],
    };
  });
  const {
    messages: _messages,
    localDiagnostics: _localDiagnostics,
    headroom: _headroom,
    warning,
    lmc: rawLmc,
    ...base
  } = full;
  const lmc = objectOrEmpty(rawLmc);
  const compactLmc: Obj = {};
  const lmcPages: Obj = {};
  for (const key of ['buildEntityNumber', 'uuid', 'lmcURL']) {
    const value = lmc[key];
    if (typeof value !== 'string') continue;
    const clipped = clipText(value, 240);
    compactLmc[key] = clipped.value;
    if (clipped.truncated) {
      compactLmc[`${key}Truncated`] = true;
      lmcPages[key] = { total: [...value].length, inspect: inspect(['report', key]) };
    }
  }
  if (Object.keys(lmcPages).length > 0) pages['lmc'] = lmcPages;
  const warningCharacters = typeof warning === 'string' ? [...warning] : [];
  const warningTruncated = warningCharacters.length > 500;
  const persistedWarning = warningTruncated ? `${warningCharacters.slice(0, 500).join('')}…` : warning;
  const compact: Obj = {
    ...base,
    ...(Object.keys(compactLmc).length > 0 ? { lmc: compactLmc } : {}),
    ...(persistedWarning !== undefined ? { warning: persistedWarning } : {}),
    ...(warningTruncated ? { warningTruncated: true } : {}),
    messages: messages.slice(0, 3).map(messagePreview),
    messagesReturned: Math.min(messages.length, 3),
    localDiagnostics: localDiagnostics.slice(0, 3).map(messagePreview),
    localDiagnosticsReturned: Math.min(localDiagnostics.length, 3),
    headroom: headroomSummary,
    headroomReturned: Math.min(headroom.length, 3),
    compacted: true,
    pages,
  };
  if (warningTruncated) {
    pages['warning'] = {
      total: warningCharacters.length,
      inspect: inspect(['error', 'message']),
    };
  }
  while (jsonBytes(compact) > maxBytes && (compact['messages'] as unknown[]).length > 0) {
    (compact['messages'] as unknown[]).pop();
    compact['messagesReturned'] = (compact['messages'] as unknown[]).length;
  }
  while (jsonBytes(compact) > maxBytes && (compact['localDiagnostics'] as unknown[]).length > 0) {
    (compact['localDiagnostics'] as unknown[]).pop();
    compact['localDiagnosticsReturned'] = (compact['localDiagnostics'] as unknown[]).length;
  }
  if (jsonBytes(compact) > maxBytes) {
    compact['headroom'] = headroomSummary.map(entry => ({
      configuration: entry.configuration,
      productCode: entry.productCode,
      constraintCount: entry.constraintCount,
      breachedCount: entry.breached.length,
    }));
  }
  while (jsonBytes(compact) > maxBytes && (compact['headroom'] as unknown[]).length > 0) {
    (compact['headroom'] as unknown[]).pop();
    compact['headroomReturned'] = (compact['headroom'] as unknown[]).length;
  }
  if (jsonBytes(compact) > maxBytes) {
    const keep = (key: string): unknown => {
      const value = full[key];
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? value
        : undefined;
    };
    const fallback: Obj = {
      session: keep('session'),
      workspaceId: keep('workspaceId'),
      source: keep('source'),
      status: keep('status'),
      isValid: keep('isValid'),
      terminal: keep('terminal'),
      jobId: options.jobId,
      payloadSha256: keep('payloadSha256'),
      validatedRevision: keep('validatedRevision'),
      stale: keep('stale'),
      freshValidationRequired: keep('freshValidationRequired'),
      errorCount: keep('errorCount'),
      warningCount: keep('warningCount'),
      infoCount: keep('infoCount'),
      localErrorCount: keep('localErrorCount'),
      localWarningCount: keep('localWarningCount'),
      localInfoCount: keep('localInfoCount'),
      compacted: true,
      contextOmitted: true,
      inspectSavedJob: inspect([]),
      ...(persistedWarning !== undefined ? { warning: persistedWarning } : {}),
      ...(warningTruncated ? {
        warningTruncated: true,
        warningInspect: inspect(['error', 'message']),
      } : {}),
    };
    if (jsonBytes(fallback) <= maxBytes) return fallback;
    return {
      status: keep('status'),
      isValid: keep('isValid'),
      terminal: keep('terminal'),
      jobId: options.jobId,
      stale: keep('stale'),
      freshValidationRequired: keep('freshValidationRequired'),
      errorCount: keep('errorCount'),
      warningCount: keep('warningCount'),
      infoCount: keep('infoCount'),
      localErrorCount: keep('localErrorCount'),
      localWarningCount: keep('localWarningCount'),
      localInfoCount: keep('localInfoCount'),
      compacted: true,
      contextOmitted: true,
      inspectSavedJob: inspect([]),
    };
  }
  return compact;
}

export function registerValidationTools(rawServer: McpServer, service: DcscService): void {
  const server = withToolSupport(rawServer);
  server.registerTool('dcsc_validation_jobs', {
    title: 'Inspect saved manufacturing validation jobs',
    description: 'Lists saved validation jobs in the containing workspace and recomputes staleness from the current revision and payload. Pass jobId to inspect recorded descriptors, messages, local diagnostics, headroom and raw report through continuations.',
    inputSchema: {
      session: z.string(), jobId: z.string().optional(),
      path: z.array(z.string()).optional().default([]),
      offset: z.number().int().min(0).optional().default(0),
      limit: z.number().int().min(1).max(1000).optional().default(20),
    },
  }, async args => guard(() => {
    const jobs = service.validationJobs(args.session);
    let source: unknown;
    if (args.jobId) {
      source = jobs.find(job => job.id === args.jobId);
      if (!source) throw new Error(`Validation job ${args.jobId} is not stored in this workspace.`);
    } else {
      source = jobs.map(job => ({ jobId: job.id, target: job.target, status: job.currentStatus,
        isValid: job.isValid, stale: job.stale, validatedRevision: job.validatedRevision,
        startedAt: job.startedAt, terminal: job.terminal, freshValidationRequired: job.freshValidationRequired,
        next: { tool: 'dcsc_validation_jobs', arguments: { session: args.session, jobId: job.id } } }));
    }
    return projectJsonPage(source, { tool: 'dcsc_validation_jobs',
      arguments: { session: args.session, ...(args.jobId ? { jobId: args.jobId } : {}) },
      path: args.path, offset: args.offset, limit: args.limit });
  }, 'dcsc_validation_jobs failed'));
}
