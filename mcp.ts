// mcp.ts — the Model Context Protocol surface: server/discover (modern era),
// initialize (legacy handshake, kept as a safety net), tools/list and
// tools/call for the six tools the conformance client needs. Responses are
// plain JSON-RPC 2.0 over HTTP; the tools list is a frozen constant so two
// calls are byte-identical.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { issueShape, pullShape, repoShape } from './rest.ts';
import type { Repo, Store } from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

// Frozen: tools/list must be byte-identical across calls.
const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'Repository owner login' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function okResult(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
}

function errResult(message: string): ToolResult {
  const payload = { error: message };
  return { content: [{ type: 'text', text: message }], structuredContent: payload, isError: true };
}

function missingArg(name: string): ToolResult {
  return errResult(`Missing required argument: ${name}`);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return parseInt(value, 10);
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name);
      if (!repoName) return missingArg('name');
      const owner = asString(args.owner);
      if (owner) store.learnViewer(owner);
      if (store.findRepoByName(repoName)) return errResult(`Repository ${repoName} already exists`);
      const repo = store.createRepo(repoName, asString(args.description), args.private === true);
      return okResult(repoShape(store, repo) as Record<string, unknown>);
    }
    case 'get_repo': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      if (!owner) return missingArg('owner');
      if (!repoName) return missingArg('repo');
      const repo = store.findRepo(owner, repoName);
      if (!repo) return errResult(`Repository ${owner}/${repoName} not found`);
      return okResult(repoShape(store, repo) as Record<string, unknown>);
    }
    case 'create_issue': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      const title = asString(args.title);
      if (!owner) return missingArg('owner');
      if (!repoName) return missingArg('repo');
      if (!title) return missingArg('title');
      const repo = store.findRepo(owner, repoName);
      if (!repo) return errResult(`Repository ${owner}/${repoName} not found`);
      const issue = store.createIssue(repo, title, asString(args.body), []);
      return okResult(issueShape(store, repo, issue) as Record<string, unknown>);
    }
    case 'list_issues': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      if (!owner) return missingArg('owner');
      if (!repoName) return missingArg('repo');
      const repo = store.findRepo(owner, repoName);
      if (!repo) return errResult(`Repository ${owner}/${repoName} not found`);
      const state = asString(args.state) || 'open';
      let items = [...repo.issues];
      if (state !== 'all') items = items.filter((i) => i.state === state);
      items.sort((a, b) => b.createdSeq - a.createdSeq);
      const payload = { issues: items.map((i) => issueShape(store, repo, i)) };
      return okResult(payload);
    }
    case 'create_pull_request': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      const title = asString(args.title);
      const head = asString(args.head).replace(/^[^:]+:/, '');
      const base = asString(args.base);
      if (!owner) return missingArg('owner');
      if (!repoName) return missingArg('repo');
      if (!title) return missingArg('title');
      if (!head) return missingArg('head');
      if (!base) return missingArg('base');
      const repo = store.findRepo(owner, repoName);
      if (!repo) return errResult(`Repository ${owner}/${repoName} not found`);
      const pull = store.createPull(repo, title, asString(args.body), head, base);
      if (!pull) return errResult('Head or base ref not found');
      return okResult(pullShape(store, repo, pull) as Record<string, unknown>);
    }
    case 'merge_pull_request': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      const number = asNumber(args.pull_number);
      if (!owner) return missingArg('owner');
      if (!repoName) return missingArg('repo');
      if (number === null) return missingArg('pull_number');
      const repo = store.findRepo(owner, repoName);
      if (!repo) return errResult(`Repository ${owner}/${repoName} not found`);
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return errResult(`Pull request #${number} not found`);
      if (pull.merged) return errResult(`Pull request #${number} is already merged`);
      if (!store.mergeable(pull, repo)) return errResult('Merge conflict');
      const sha = store.mergePull(repo, pull);
      if (!sha) return errResult('Merge conflict');
      return okResult(pullShape(store, repo, pull) as Record<string, unknown>);
    }
    default:
      return errResult(`Unknown tool: ${name}`);
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length });
  res.end(body);
}

export function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  // Auth: every /mcp call needs a non-empty Bearer token.
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ') || auth.slice(7).trim().length === 0) {
    let id: unknown = null;
    try {
      const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && 'id' in parsed) id = parsed.id;
    } catch {
      // keep id null
    }
    sendJson(res, 401, { jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized' } });
    return;
  }

  let request: unknown;
  try {
    request = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const rec = request as Record<string, unknown>;
  const method = typeof rec.method === 'string' ? rec.method : '';
  const id = 'id' in rec ? rec.id : undefined;
  const params = (rec.params && typeof rec.params === 'object' ? rec.params : {}) as Record<string, unknown>;

  // Notifications carry no id and get no JSON-RPC response.
  if (id === undefined) {
    res.writeHead(202);
    res.end();
    return;
  }

  const ok = (result: unknown): void => sendJson(res, 200, { jsonrpc: '2.0', id, result });
  const err = (code: number, message: string): void =>
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'server/discover': {
      ok({
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
      return;
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
      ok({
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    }
    case 'ping': {
      ok({});
      return;
    }
    case 'tools/list': {
      ok({ tools: TOOLS });
      return;
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const toolArgs = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      const known = TOOLS.some((t) => t.name === toolName);
      if (!known) {
        err(-32602, `Unknown tool: ${toolName}`);
        return;
      }
      ok(callTool(store, toolName, toolArgs));
      return;
    }
    default: {
      err(-32601, `Method not found: ${method}`);
      return;
    }
  }
  void req;
}
