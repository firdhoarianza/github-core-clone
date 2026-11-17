import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gitFetch, gitPush, gitRefs, gitUploadV2 } from './lib/git.ts';
import { handleGraphqlBody } from './lib/graphql.ts';
import { handleMcpBody } from './lib/mcp.ts';
import { handleRest } from './lib/rest.ts';
import { getRepo, token, viewer } from './lib/store.ts';

const jsonHeaders = (response: ServerResponse, status: number, body: any, extra: Record<string, string> = {}): void => {
  const serialized = status === 204 ? '' : JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': nextRequestId(), ...extra,
    ...(serialized ? { 'content-length': Buffer.byteLength(serialized) } : {}) });
  response.end(serialized);
};
const sendError = (response: ServerResponse, status: number, message: string): void => jsonHeaders(response, status, { message });
const sendBuffer = (response: ServerResponse, status: number, type: string, body: Buffer): void => {
  response.writeHead(status, { 'content-type': type, 'content-length': body.length, 'x-github-request-id': nextRequestId() }); response.end(body);
};
let requestSequence = 0;
function nextRequestId(): string { return 'forge-' + (++requestSequence).toString(36); }

function requestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', () => resolve(Buffer.alloc(0)));
  });
}
function parseJson(raw: Buffer): { value?: any; invalid: boolean } {
  if (raw.length === 0) return { value: {}, invalid: false };
  try { return { value: JSON.parse(raw.toString('utf8')), invalid: false }; }
  catch { return { invalid: true }; }
}
const isAuthorized = (request: IncomingMessage) => (request.headers.authorization || '') === 'Bearer ' + token && token !== '';
const allowedApiMethod = (method: string) => ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method);

function gitRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> | boolean {
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
  if (!match) return false;
  const [, owner, name, endpoint] = match;
  const repo = getRepo(owner!, name!);
  if (!repo) { sendError(response, 404, 'Not Found'); return true; }
  const version2 = (request.headers['git-protocol'] || '').includes('version=2');
  if (endpoint === 'info/refs') {
    if (request.method !== 'GET') { sendError(response, 405, 'Method Not Allowed'); return true; }
    const service = url.searchParams.get('service') || 'git-upload-pack';
    sendBuffer(response, 200, 'application/x-' + service + '-advertisement', gitRefs(repo, service, version2));
    return true;
  }
  return requestBody(request).then((body) => {
    const payload = endpoint === 'git-upload-pack' ? (version2 ? gitUploadV2(repo, body) : gitFetch(repo, body, false)) : gitPush(repo, body);
    sendBuffer(response, 200, 'application/x-' + endpoint + '-result', payload);
    return true;
  });
}

function apiRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> | boolean {
  const pathname = url.pathname, method = request.method || 'GET';
  const isRest = pathname === '/api/v3' || pathname.startsWith('/api/v3/');
  const isGraphql = pathname === '/api/graphql';
  const isMcp = pathname === '/mcp';
  if (!isRest && !isGraphql && !isMcp) return false;
  if (!isAuthorized(request)) { sendError(response, 401, 'Requires authentication'); return true; }
  if (isRest) {
    if (!allowedApiMethod(method)) { sendError(response, 405, 'Method Not Allowed'); return true; }
    if (method === 'GET') { handleRest(request, response, url, null, jsonHeaders, sendError); return true; }
    return requestBody(request).then((raw) => {
      const parsed = parseJson(raw);
      if (parsed.invalid) { sendError(response, 400, 'Problems parsing JSON'); return true; }
      handleRest(request, response, url, parsed.value, jsonHeaders, sendError); return true;
    });
  }
  if (method !== 'POST') { sendError(response, 405, 'Method Not Allowed'); return true; }
  return requestBody(request).then((raw) => {
    const parsed = parseJson(raw);
    if (parsed.invalid) {
      if (isMcp) jsonHeaders(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      else sendError(response, 400, 'Problems parsing JSON');
      return true;
    }
    const body = parsed.value;
    if (isGraphql) jsonHeaders(response, 200, handleGraphqlBody(body));
    else if (!Array.isArray(body) && body?.method === 'notifications/initialized') response.writeHead(202, { 'x-github-request-id': nextRequestId() }).end();
    else jsonHeaders(response, 200, handleMcpBody(body, viewer));
    return true;
  });
}

/** Create the HTTP application without binding; main.ts owns the harness lifecycle and listen call. */
export function createApp(): Server {
  return createServer(async (request, response) => {
    let url: URL;
    try { url = new URL(request.url || '/', 'http://entry'); }
    catch { sendError(response, 400, 'Bad Request'); return; }

    if (url.pathname === '/healthz' && request.method === 'GET') { jsonHeaders(response, 200, { ok: true }); return; }
    if (await gitRoute(request, response, url)) return;
    if (await apiRoute(request, response, url)) return;
    sendError(response, 404, 'Not Found');
  });
}
