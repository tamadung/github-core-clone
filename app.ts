// app.ts — the forge's HTTP server: routing, body collection, and dispatch
// to the git smart-HTTP, REST v3, GraphQL and MCP surfaces. One process, one
// in-memory store, no disk writes at request time.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitserver.ts';
import { handleRest, requestId } from './rest.ts';
import { handleGraphqlBody } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { Store } from './store.ts';

const MAX_BODY_BYTES = 128 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): ReturnType<typeof createServer> {
  const store = new Store();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const path = url.pathname;
      const method = req.method ?? 'GET';

      // ---- health probe (the env's boot check calls this twice) ----
      if (method === 'GET' && path === '/healthz') {
        const body = Buffer.from(JSON.stringify({ ok: true }), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': requestId(), 'Content-Length': body.length });
        res.end(body);
        return;
      }

      // ---- GitHub API root ----
      if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
        const body = Buffer.from(JSON.stringify({ current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-OAuth-Scopes': 'repo, read:org', 'X-GitHub-Request-Id': requestId(), 'Content-Length': body.length });
        res.end(body);
        return;
      }

      // ---- GitHub meta ----
      if (method === 'GET' && path === '/api/v3/meta') {
        const body = Buffer.from(
          JSON.stringify({
            verifiable_password_authentication: true,
            github_enterprise_importer_enabled: false,
            installed_version: '1.0.0',
            hooks: [],
            git: [],
            pages: [],
            importer: [],
            actions: [],
            packages: [],
            domains: {},
          }),
          'utf8',
        );
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': requestId(), 'Content-Length': body.length });
        res.end(body);
        return;
      }

      // ---- git smart HTTP: /{owner}/{repo}.git/info/refs, /git-upload-pack, /git-receive-pack ----
      const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1]);
        const repoName = decodeURIComponent(gitMatch[2]);
        const service = gitMatch[3];
        const gitProtocol = req.headers['git-protocol'] as string | undefined;
        if (service === 'info/refs' && method === 'GET') {
          handleInfoRefs(store, owner, repoName, url.searchParams.get('service') ?? '', gitProtocol, res);
          return;
        }
        if (service === 'git-upload-pack' && method === 'POST') {
          const body = await readBody(req);
          handleUploadPack(store, owner, repoName, body, gitProtocol, res);
          return;
        }
        if (service === 'git-receive-pack' && method === 'POST') {
          const body = await readBody(req);
          handleReceivePack(store, owner, repoName, body, res);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // ---- GraphQL: POST /api/graphql (Bearer required) ----
      if (path === '/api/graphql' && method === 'POST') {
        const auth = req.headers.authorization ?? '';
        if (!auth.startsWith('Bearer ') || auth.slice(7).trim().length === 0) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const body = await readBody(req);
        const { status, payload } = handleGraphqlBody(store, body);
        sendJson(res, status, payload);
        return;
      }

      // ---- MCP: POST /mcp ----
      if (path === '/mcp' && method === 'POST') {
        const body = await readBody(req);
        handleMcp(store, req, res, body);
        return;
      }

      // ---- REST v3: /api/v3/... ----
      if (path.startsWith('/api/v3/')) {
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        handleRest(store, req, res, body, url);
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { message: (err as Error).message || 'Internal Server Error' });
      } else {
        res.destroy();
      }
    }
  });
  return server;
}
