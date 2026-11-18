// rest.ts — the GitHub REST v3 surface: repos, issues, pulls, labels,
// comments, commits, contents and git refs. Responses are JSON with an
// X-GitHub-Request-Id on every one; shapes carry the fields the conformance
// client reads, plus the usual GitHub extras (extra fields are allowed).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { isAncestor, parseCommit, parseTree } from './git.ts';
import { tsFor } from './store.ts';
import type { Issue, Label, Pull, Repo, Store } from './store.ts';

let requestCounter = 0;

export function requestId(): string {
  requestCounter += 1;
  return `req_${requestCounter.toString(16).padStart(8, '0')}`;
}

function sendJson(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-GitHub-Request-Id': requestId(),
    'Content-Length': body.length,
    ...extra,
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message, documentation_url: 'https://docs.github.com/rest' });
}

function sendNoContent(res: ServerResponse, status = 204): void {
  res.writeHead(status, { 'X-GitHub-Request-Id': requestId() });
  res.end();
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function userShape(login: string): Record<string, unknown> {
  return { login, id: 1, node_id: b64(`User:${login}`), avatar_url: '', type: 'User', site_admin: false };
}

export function repoShape(store: Store, repo: Repo): Record<string, unknown> {
  const owner = store.repoOwner(repo);
  return {
    id: repo.id,
    node_id: b64(`Repository:${repo.id}`),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: userShape(owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: tsFor(repo.createdSeq),
    updated_at: tsFor(repo.createdSeq),
    pushed_at: tsFor(repo.createdSeq),
    html_url: `https://github.com/${owner}/${repo.name}`,
    url: `/repos/${owner}/${repo.name}`,
    clone_url: `https://github.com/${owner}/${repo.name}.git`,
    git_url: `git://github.com/${owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    topics: [],
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    size: 0,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    license: null,
  };
}

function labelShape(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: b64(`Label:${label.id}`), name: label.name, color: label.color, description: label.description, default: false };
}

export function issueShape(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = store.repoOwner(repo);
  return {
    id: issue.id,
    node_id: b64(`Issue:${issue.id}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map(labelShape),
    user: userShape(issue.user || owner),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: tsFor(issue.createdSeq),
    updated_at: tsFor(issue.updatedSeq),
    closed_at: issue.state === 'closed' ? tsFor(issue.updatedSeq) : null,
    html_url: `https://github.com/${owner}/${repo.name}/issues/${issue.number}`,
    url: `/repos/${owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/repos/${owner}/${repo.name}`,
    author_association: 'OWNER',
  };
}

export function pullShape(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = store.repoOwner(repo);
  const headRepo = repoShape(store, repo);
  return {
    id: pull.id,
    node_id: b64(`PullRequest:${pull.id}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    mergeable: store.mergeable(pull, repo),
    mergeable_state: pull.merged ? 'clean' : store.mergeable(pull, repo) ? 'clean' : 'dirty',
    draft: false,
    head: { label: `${owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, user: userShape(owner), repo: headRepo },
    base: { label: `${owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, user: userShape(owner), repo: headRepo },
    user: userShape(pull.user || owner),
    created_at: tsFor(pull.createdSeq),
    updated_at: tsFor(pull.updatedSeq),
    closed_at: pull.state === 'closed' ? tsFor(pull.updatedSeq) : null,
    html_url: `https://github.com/${owner}/${repo.name}/pull/${pull.number}`,
    url: `/repos/${owner}/${repo.name}/pulls/${pull.number}`,
    commits_url: `/repos/${owner}/${repo.name}/pulls/${pull.number}/commits`,
    comments_url: `/repos/${owner}/${repo.name}/issues/${pull.number}/comments`,
    review_comments_url: `/repos/${owner}/${repo.name}/pulls/${pull.number}/comments`,
    requested_reviewers: [],
    labels: [],
    milestone: null,
    author_association: 'OWNER',
  };
}

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: T[], page: number, perPage: number): { pageItems: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { pageItems: items.slice(start, start + perPage), totalPages };
}

function linkHeader(req: IncomingMessage, path: string, query: URLSearchParams, page: number, perPage: number, totalPages: number): string {
  const host = req.headers.host ?? '127.0.0.1';
  const links: string[] = [];
  const build = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `http://${host}${path}?${q.toString()}`;
  };
  if (page < totalPages) links.push(`<${build(page + 1)}>; rel="next"`);
  if (page < totalPages) links.push(`<${build(totalPages)}>; rel="last"`);
  if (page > 1) links.push(`<${build(1)}>; rel="first"`);
  if (page > 1) links.push(`<${build(page - 1)}>; rel="prev"`);
  return links.join(', ');
}

function parseJsonBody(body: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (!body.length) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ok: true, value: parsed as Record<string, unknown> };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return [value];
  return [];
}

export function handleRest(store: Store, req: IncomingMessage, res: ServerResponse, body: Buffer, urlObj?: URL): void {
  const url = urlObj ?? new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const path = url.pathname;
  const query = url.searchParams;
  const method = req.method ?? 'GET';

  // Auth: every /api/v3 route needs a non-empty Bearer token.
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ') || auth.slice(7).trim().length === 0) {
    sendError(res, 401, 'Requires authentication');
    return;
  }

  const parsed = parseJsonBody(body);
  if (!parsed.ok && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    sendError(res, 400, 'Problems parsing JSON');
    return;
  }
  const input = parsed.ok ? parsed.value : {};

  const segments = path.split('/').filter(Boolean);
  // All routes live under /api/v3.
  if (segments[0] !== 'api' || segments[1] !== 'v3') {
    sendError(res, 404, 'Not Found');
    return;
  }
  const rest = segments.slice(2);

  // ---- /user ----
  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (!store.viewer) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, { login: store.viewer, id: 1, node_id: b64(`User:${store.viewer}`), type: 'User', site_admin: false });
    return;
  }

  // ---- POST /user/repos, GET /user/repos ----
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'POST') {
      const name = asString(input.name);
      if (!name || name.length > 100 || /[\s]/.test(name)) {
        sendError(res, 422, 'Validation Failed');
        return;
      }
      if (store.findRepoByName(name)) {
        sendError(res, 422, 'Repository already exists');
        return;
      }
      const repo = store.createRepo(name, asString(input.description), input.private === true);
      sendJson(res, 201, repoShape(store, repo));
      return;
    }
    if (method === 'GET') {
      const { page, perPage } = parsePage(query);
      const owned = store.repos.filter((r) => (r.owner ?? store.viewer) === store.viewer);
      const { pageItems, totalPages } = paginate(owned, page, perPage);
      const extra: Record<string, string> = {};
      const link = linkHeader(req, path, query, page, perPage, totalPages);
      if (link) extra.Link = link;
      sendJson(res, 200, pageItems.map((r) => repoShape(store, r)), extra);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // ---- /repos/:owner/:repo/... ----
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = decodeURIComponent(rest[1]);
    const repoName = decodeURIComponent(rest[2]);
    const repo = store.findRepo(owner, repoName);
    if (!repo) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const tail = rest.slice(3);
    return handleRepoRoute(store, req, res, repo, tail, query, method, input, path);
  }

  sendError(res, 404, 'Not Found');
}

function handleRepoRoute(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  tail: string[],
  query: URLSearchParams,
  method: string,
  input: Record<string, unknown>,
  path: string,
): void {
  const owner = store.repoOwner(repo);

  // ---- the repo itself ----
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoShape(store, repo));
      return;
    }
    if (method === 'PATCH') {
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.private = input.private;
      sendJson(res, 200, repoShape(store, repo));
      return;
    }
    if (method === 'DELETE') {
      store.repos = store.repos.filter((r) => r !== repo);
      store.byName.delete(repo.name);
      sendNoContent(res, 204);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  const resource = tail[0];

  // ---- issues ----
  if (resource === 'issues') {
    // /issues (list / create)
    if (tail.length === 1) {
      if (method === 'GET') {
        const { page, perPage } = parsePage(query);
        const state = query.get('state') ?? 'open';
        let items = [...repo.issues];
        if (state !== 'all') items = items.filter((i) => i.state === state);
        const labelFilter = query.get('labels');
        if (labelFilter) {
          const wanted = labelFilter.split(',').map((s) => s.trim()).filter(Boolean);
          items = items.filter((i) => wanted.every((w) => i.labels.some((l) => l.name === w)));
        }
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        const key = sort === 'updated' ? (i: Issue) => i.updatedSeq : (i: Issue) => i.createdSeq;
        items.sort((a, b) => (direction === 'asc' ? key(a) - key(b) : key(b) - key(a)));
        const { pageItems, totalPages } = paginate(items, page, perPage);
        const extra: Record<string, string> = {};
        const link = linkHeader(req, path, query, page, perPage, totalPages);
        if (link) extra.Link = link;
        sendJson(res, 200, pageItems.map((i) => issueShape(store, repo, i)), extra);
        return;
      }
      if (method === 'POST') {
        const title = asString(input.title);
        if (!title) {
          sendError(res, 422, 'Validation Failed');
          return;
        }
        const labelNames = asStringArray(input.labels);
        const unknown = labelNames.filter((name) => !repo.labels.some((l) => l.name === name));
        if (unknown.length) {
          sendError(res, 422, `Validation Failed: label "${unknown[0]}" does not exist`);
          return;
        }
        const issue = store.createIssue(repo, title, asString(input.body), labelNames);
        sendJson(res, 201, issueShape(store, repo, issue));
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    const number = parseInt(tail[1], 10);
    if (!Number.isFinite(number)) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const issue = repo.issues.find((i) => i.number === number);
    if (!issue) {
      sendError(res, 404, 'Not Found');
      return;
    }
    // /issues/:number/comments
    if (tail.length === 3 && tail[2] === 'comments') {
      if (method === 'GET') {
        const { page, perPage } = parsePage(query);
        const { pageItems, totalPages } = paginate(issue.comments, page, perPage);
        const extra: Record<string, string> = {};
        const link = linkHeader(req, path, query, page, perPage, totalPages);
        if (link) extra.Link = link;
        sendJson(
          res,
          200,
          pageItems.map((c) => ({
            id: c.id,
            node_id: b64(`IssueComment:${c.id}`),
            body: c.body,
            user: userShape(c.user || owner),
            created_at: tsFor(c.createdSeq),
            updated_at: tsFor(c.createdSeq),
            html_url: `https://github.com/${owner}/${repo.name}/issues/${issue.number}#issuecomment-${c.id}`,
            url: `/repos/${owner}/${repo.name}/issues/comments/${c.id}`,
            issue_url: `/repos/${owner}/${repo.name}/issues/${issue.number}`,
          })),
          extra,
        );
        return;
      }
      if (method === 'POST') {
        const commentBody = asString(input.body);
        if (!commentBody) {
          sendError(res, 422, 'Validation Failed');
          return;
        }
        const comment = { id: store.nextCommentId++, body: commentBody, user: store.viewer ?? '', createdSeq: store.nextSeq() };
        issue.comments.push(comment);
        issue.updatedSeq = store.seq;
        repo.issueJson.delete(issue.number);
        sendJson(res, 201, {
          id: comment.id,
          node_id: b64(`IssueComment:${comment.id}`),
          body: comment.body,
          user: userShape(comment.user || owner),
          created_at: tsFor(comment.createdSeq),
          updated_at: tsFor(comment.createdSeq),
          html_url: `https://github.com/${owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
          url: `/repos/${owner}/${repo.name}/issues/comments/${comment.id}`,
          issue_url: `/repos/${owner}/${repo.name}/issues/${issue.number}`,
        });
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    if (tail.length === 2) {
      if (method === 'GET') {
        const cached = repo.issueJson.get(issue.number);
        if (cached) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': requestId(), 'Content-Length': cached.length });
          res.end(cached);
          return;
        }
        const body = Buffer.from(JSON.stringify(issueShape(store, repo, issue)), 'utf8');
        repo.issueJson.set(issue.number, body);
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': requestId(), 'Content-Length': body.length });
        res.end(body);
        return;
      }
      if (method === 'PATCH') {
        if (typeof input.title === 'string') issue.title = input.title;
        if (typeof input.body === 'string') issue.body = input.body;
        if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
        if (input.labels !== undefined) {
          const labelNames = asStringArray(input.labels);
          const unknown = labelNames.filter((name) => !repo.labels.some((l) => l.name === name));
          if (unknown.length) {
            sendError(res, 422, `Validation Failed: label "${unknown[0]}" does not exist`);
            return;
          }
          issue.labels = labelNames.map((name) => store.getOrCreateLabel(repo, name));
        }
        issue.updatedSeq = store.nextSeq();
        repo.issueJson.delete(issue.number);
        sendJson(res, 200, issueShape(store, repo, issue));
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // ---- issue comments by id ----
  if (resource === 'issues' && tail[1] === 'comments' && tail.length === 3) {
    const commentId = parseInt(tail[2], 10);
    for (const issue of repo.issues) {
      const comment = issue.comments.find((c) => c.id === commentId);
      if (!comment) continue;
      if (method === 'GET') {
        sendJson(res, 200, {
          id: comment.id,
          node_id: b64(`IssueComment:${comment.id}`),
          body: comment.body,
          user: userShape(comment.user || owner),
          created_at: tsFor(comment.createdSeq),
          updated_at: tsFor(comment.createdSeq),
          url: `/repos/${owner}/${repo.name}/issues/comments/${comment.id}`,
          issue_url: `/repos/${owner}/${repo.name}/issues/${issue.number}`,
        });
        return;
      }
      if (method === 'PATCH') {
        if (typeof input.body === 'string') comment.body = input.body;
        issue.updatedSeq = store.nextSeq();
        repo.issueJson.delete(issue.number);
        sendJson(res, 200, {
          id: comment.id,
          node_id: b64(`IssueComment:${comment.id}`),
          body: comment.body,
          user: userShape(comment.user || owner),
          created_at: tsFor(comment.createdSeq),
          updated_at: tsFor(comment.createdSeq),
          url: `/repos/${owner}/${repo.name}/issues/comments/${comment.id}`,
          issue_url: `/repos/${owner}/${repo.name}/issues/${issue.number}`,
        });
        return;
      }
      if (method === 'DELETE') {
        issue.comments = issue.comments.filter((c) => c.id !== commentId);
        issue.updatedSeq = store.nextSeq();
        repo.issueJson.delete(issue.number);
        sendNoContent(res, 204);
        return;
      }
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // ---- labels ----
  if (resource === 'labels') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const { page, perPage } = parsePage(query);
        const { pageItems, totalPages } = paginate(repo.labels, page, perPage);
        const extra: Record<string, string> = {};
        const link = linkHeader(req, path, query, page, perPage, totalPages);
        if (link) extra.Link = link;
        sendJson(res, 200, pageItems.map(labelShape), extra);
        return;
      }
      if (method === 'POST') {
        const name = asString(input.name);
        if (!name) {
          sendError(res, 422, 'Validation Failed');
          return;
        }
        const existing = repo.labels.find((l) => l.name === name);
        if (existing) {
          sendJson(res, 201, labelShape(existing));
          return;
        }
        const label: Label = {
          id: store.nextLabelId++,
          name,
          color: asString(input.color) || 'ededed',
          description: asString(input.description),
        };
        repo.labels.push(label);
        sendJson(res, 201, labelShape(label));
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    if (tail.length === 2) {
      const name = decodeURIComponent(tail[1]);
      const label = repo.labels.find((l) => l.name === name);
      if (!label) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, labelShape(label));
        return;
      }
      if (method === 'PATCH') {
        if (typeof input.name === 'string' && input.name) label.name = input.name;
        if (typeof input.color === 'string') label.color = input.color;
        if (typeof input.description === 'string') label.description = input.description;
        sendJson(res, 200, labelShape(label));
        return;
      }
      if (method === 'DELETE') {
        repo.labels = repo.labels.filter((l) => l !== label);
        for (const issue of repo.issues) {
          issue.labels = issue.labels.filter((l) => l !== label);
          repo.issueJson.delete(issue.number);
        }
        sendNoContent(res, 204);
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // ---- pulls ----
  if (resource === 'pulls') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const { page, perPage } = parsePage(query);
        const state = query.get('state') ?? 'open';
        let items = [...repo.pulls];
        if (state !== 'all') items = items.filter((p) => p.state === state);
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        const key = sort === 'updated' ? (p: Pull) => p.updatedSeq : (p: Pull) => p.createdSeq;
        items.sort((a, b) => (direction === 'asc' ? key(a) - key(b) : key(b) - key(a)));
        const { pageItems, totalPages } = paginate(items, page, perPage);
        const extra: Record<string, string> = {};
        const link = linkHeader(req, path, query, page, perPage, totalPages);
        if (link) extra.Link = link;
        sendJson(res, 200, pageItems.map((p) => pullShape(store, repo, p)), extra);
        return;
      }
      if (method === 'POST') {
        const title = asString(input.title);
        const head = asString(input.head).replace(/^[^:]+:/, '');
        const base = asString(input.base);
        if (!title || !head || !base) {
          sendError(res, 422, 'Validation Failed');
          return;
        }
        const pull = store.createPull(repo, title, asString(input.body), head, base);
        if (!pull) {
          sendError(res, 422, 'Validation Failed: head or base ref not found');
          return;
        }
        sendJson(res, 201, pullShape(store, repo, pull));
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    const number = parseInt(tail[1], 10);
    if (!Number.isFinite(number)) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const pull = repo.pulls.find((p) => p.number === number);
    if (!pull) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (tail.length === 2) {
      if (method === 'GET') {
        sendJson(res, 200, pullShape(store, repo, pull));
        return;
      }
      if (method === 'PATCH') {
        if (typeof input.title === 'string') pull.title = input.title;
        if (typeof input.body === 'string') pull.body = input.body;
        if (input.state === 'open' || input.state === 'closed') pull.state = input.state;
        pull.updatedSeq = store.nextSeq();
        sendJson(res, 200, pullShape(store, repo, pull));
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      const baseTip = store.resolveRef(repo, pull.baseRef);
      const baseCommit = baseTip ? repo.objects.get(baseTip) : undefined;
      const headCommit = repo.objects.get(pull.headSha);
      if (!baseCommit || baseCommit.type !== 'commit' || !headCommit || headCommit.type !== 'commit') {
        sendError(res, 422, 'Validation Failed');
        return;
      }
      const files = store.diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
      const { page, perPage } = parsePage(query);
      const { pageItems, totalPages } = paginate(files, page, perPage);
      const extra: Record<string, string> = {};
      const link = linkHeader(req, path, query, page, perPage, totalPages);
      if (link) extra.Link = link;
      sendJson(
        res,
        200,
        pageItems.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          patch: '',
          sha: '',
          blob_url: '',
          raw_url: '',
        })),
        extra,
      );
      return;
    }
    if (tail.length === 3 && tail[2] === 'merge') {
      if (method === 'GET') {
        if (pull.merged) {
          sendNoContent(res, 204);
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'PUT') {
        if (pull.merged) {
          sendError(res, 405, 'Pull Request is already merged');
          return;
        }
        if (pull.state !== 'open') {
          sendError(res, 405, 'Pull Request is closed');
          return;
        }
        if (!store.mergeable(pull, repo)) {
          sendError(res, 405, 'Merge conflict');
          return;
        }
        const sha = store.mergePull(repo, pull);
        if (!sha) {
          sendError(res, 405, 'Merge conflict');
          return;
        }
        sendJson(res, 200, { merged: true, message: 'Pull Request successfully merged', sha });
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    if (tail.length === 3 && tail[2] === 'commits' && method === 'GET') {
      const commits = store.commitsFrom(repo, pull.headSha);
      const baseTip = store.resolveRef(repo, pull.baseRef);
      const baseSet = new Set(store.commitsFrom(repo, baseTip ?? '').map((c) => c.oid));
      const unique = commits.filter((c) => !baseSet.has(c.oid));
      sendJson(
        res,
        200,
        unique.map((c) => commitShape(store, repo, c.oid, c.commit)),
      );
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // ---- commits ----
  if (resource === 'commits') {
    if (tail.length === 1 && method === 'GET') {
      const { page, perPage } = parsePage(query);
      const sha = query.get('sha') ?? repo.defaultBranch;
      const commits = store.commitsFrom(repo, sha);
      const { pageItems, totalPages } = paginate(commits, page, perPage);
      const extra: Record<string, string> = {};
      const link = linkHeader(req, path, query, page, perPage, totalPages);
      if (link) extra.Link = link;
      sendJson(
        res,
        200,
        pageItems.map((c) => commitShape(store, repo, c.oid, c.commit)),
        extra,
      );
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      const ref = decodeURIComponent(tail[1]);
      const oid = store.resolveRef(repo, ref);
      if (!oid) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, commitShape(store, repo, oid, parseCommit(object.data)));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // ---- git refs ----
  if (resource === 'git' && tail[1] === 'refs') {
    // POST /git/refs: create a branch or tag ref.
    if (tail.length === 2 && method === 'POST') {
      const ref = asString(input.ref);
      const sha = asString(input.sha);
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
        sendError(res, 422, 'Validation Failed');
        return;
      }
      if (repo.refs.has(ref)) {
        sendError(res, 422, 'Validation Failed: ref already exists');
        return;
      }
      const object = repo.objects.get(sha);
      if (!object) {
        sendError(res, 422, 'Validation Failed: sha not found');
        return;
      }
      if (ref.startsWith('refs/heads/') && object.type !== 'commit') {
        sendError(res, 422, 'Validation Failed: branch ref must point at a commit');
        return;
      }
      repo.refs.set(ref, sha);
      store.invalidateGitCaches(repo);
      sendJson(res, 201, {
        ref,
        node_id: b64(`Ref:${ref}`),
        url: `/repos/${owner}/${repo.name}/git/refs/${ref.slice(5)}`,
        object: { sha, type: object.type, url: `/repos/${owner}/${repo.name}/git/${object.type}s/${sha}` },
      });
      return;
    }
    if (tail.length >= 3) {
      const refPath = tail.slice(2).map((s) => decodeURIComponent(s)).join('/');
      const fullRef = `refs/${refPath}`;
      if (method === 'GET') {
        const oid = repo.refs.get(fullRef);
        if (!oid) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const object = repo.objects.get(oid);
        sendJson(res, 200, {
          ref: fullRef,
          node_id: b64(`Ref:${fullRef}`),
          url: `/repos/${owner}/${repo.name}/git/refs/${refPath}`,
          object: { sha: oid, type: object?.type ?? 'commit', url: `/repos/${owner}/${repo.name}/git/${object?.type ?? 'commit'}s/${oid}` },
        });
        return;
      }
      if (method === 'PATCH') {
        const oid = repo.refs.get(fullRef);
        if (!oid) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const sha = asString(input.sha);
        const force = input.force === true;
        const object = repo.objects.get(sha);
        if (!/^[0-9a-f]{40}$/.test(sha) || !object) {
          sendError(res, 422, 'Validation Failed: sha not found');
          return;
        }
        if (!force) {
          if (!isAncestor(oid, sha, (id: string) => repo.objects.get(id))) {
            sendError(res, 422, 'Validation Failed: not a fast-forward');
            return;
          }
        }
        repo.refs.set(fullRef, sha);
        store.invalidateGitCaches(repo);
        sendJson(res, 200, {
          ref: fullRef,
          node_id: b64(`Ref:${fullRef}`),
          url: `/repos/${owner}/${repo.name}/git/refs/${refPath}`,
          object: { sha, type: object.type, url: `/repos/${owner}/${repo.name}/git/${object.type}s/${sha}` },
        });
        return;
      }
      if (method === 'DELETE') {
        if (!repo.refs.has(fullRef)) {
          sendError(res, 404, 'Not Found');
          return;
        }
        repo.refs.delete(fullRef);
        store.invalidateGitCaches(repo);
        sendNoContent(res, 204);
        return;
      }
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // ---- branches ----
  if (resource === 'branches' && tail.length === 1 && method === 'GET') {
    const { page, perPage } = parsePage(query);
    const branches = [...repo.refs.entries()]
      .filter(([name]) => name.startsWith('refs/heads/'))
      .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid, url: `/repos/${owner}/${repo.name}/commits/${oid}` }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    const { pageItems, totalPages } = paginate(branches, page, perPage);
    const extra: Record<string, string> = {};
    const link = linkHeader(req, path, query, page, perPage, totalPages);
    if (link) extra.Link = link;
    sendJson(res, 200, pageItems, extra);
    return;
  }

  // ---- contents ----
  if (resource === 'contents') {
    const filePath = tail.slice(1).map((s) => decodeURIComponent(s)).join('/');
    if (!filePath) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const branch = asString(input.branch) || asString(query.get('ref') ?? '') || repo.defaultBranch;
    if (method === 'GET') {
      const tip = store.resolveRef(repo, branch);
      if (!tip) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const commit = repo.objects.get(tip);
      if (!commit || commit.type !== 'commit') {
        sendError(res, 404, 'Not Found');
        return;
      }
      const treeOid = parseCommit(commit.data).tree;
      const entry = store.blobAtPath(repo, treeOid, filePath);
      if (entry) {
        const blob = repo.objects.get(entry.oid);
        if (!blob) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, contentShape(store, repo, filePath, entry.oid, blob.data));
        return;
      }
      // A directory path lists its entries, GitHub-style.
      const dirTreeOid = treeAtPath(repo, treeOid, filePath);
      if (dirTreeOid) {
        const dirObject = repo.objects.get(dirTreeOid);
        if (dirObject && dirObject.type === 'tree') {
          const entries = parseTree(dirObject.data).map((e) => {
            const childPath = `${filePath}/${e.name}`;
            const isDir = e.mode === '40000';
            const child = !isDir ? repo.objects.get(e.oid) : undefined;
            return {
              type: isDir ? 'dir' : 'file',
              encoding: isDir ? undefined : 'base64',
              size: child ? child.data.length : 0,
              name: e.name,
              path: childPath,
              content: undefined,
              sha: e.oid,
              url: `/repos/${owner}/${repo.name}/contents/${childPath}`,
              html_url: `https://github.com/${owner}/${repo.name}/blob/main/${childPath}`,
              git_url: `/repos/${owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${e.oid}`,
              download_url: isDir ? null : `https://raw.githubusercontent.com/${owner}/${repo.name}/main/${childPath}`,
              _links: { self: `/repos/${owner}/${repo.name}/contents/${childPath}`, git: `/repos/${owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${e.oid}`, html: `https://github.com/${owner}/${repo.name}/blob/main/${childPath}` },
            };
          });
          sendJson(res, 200, entries);
          return;
        }
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    if (method === 'PUT') {
      const message = asString(input.message);
      const contentB64 = asString(input.content);
      const sha = asString(input.sha);
      if (!message || !contentB64) {
        sendError(res, 422, 'Validation Failed');
        return;
      }
      const data = Buffer.from(contentB64, 'base64');
      const tip = store.resolveRef(repo, branch);
      let files = new Map<string, { data: Buffer; mode: string }>();
      let isUpdate = false;
      if (tip) {
        const commit = repo.objects.get(tip);
        if (commit && commit.type === 'commit') {
          files = store.treeFileMap(repo, parseCommit(commit.data).tree);
        }
        const existing = files.get(filePath);
        if (existing) {
          isUpdate = true;
          const existingSha = hashBlob(existing.data);
          if (sha && sha !== existingSha) {
            sendError(res, 409, 'Conflict: sha does not match');
            return;
          }
        } else if (sha) {
          sendError(res, 422, 'Validation Failed: sha given for a new file');
          return;
        }
      }
      files.set(filePath, { data, mode: '100644' });
      const commitOid = store.commitFiles(repo, files, message, tip);
      repo.refs.set(`refs/heads/${branch}`, commitOid);
      store.invalidateGitCaches(repo);
      const blobSha = hashBlob(data);
      sendJson(res, isUpdate ? 200 : 201, {
        content: contentShape(store, repo, filePath, blobSha, data),
        commit: { sha: commitOid, message, author: { name: 'Conformance', email: 'conformance@make.fun' }, committer: { name: 'Conformance', email: 'conformance@make.fun' } },
      });
      return;
    }
    if (method === 'DELETE') {
      const message = asString(input.message);
      const sha = asString(input.sha);
      if (!message || !sha) {
        sendError(res, 422, 'Validation Failed');
        return;
      }
      const tip = store.resolveRef(repo, branch);
      if (!tip) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const commit = repo.objects.get(tip);
      if (!commit || commit.type !== 'commit') {
        sendError(res, 404, 'Not Found');
        return;
      }
      const files = store.treeFileMap(repo, parseCommit(commit.data).tree);
      const existing = files.get(filePath);
      if (!existing) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (sha !== hashBlob(existing.data)) {
        sendError(res, 409, 'Conflict: sha does not match');
        return;
      }
      files.delete(filePath);
      const commitOid = store.commitFiles(repo, files, message, tip);
      repo.refs.set(`refs/heads/${branch}`, commitOid);
      store.invalidateGitCaches(repo);
      sendJson(res, 200, {
        commit: { sha: commitOid, message, author: { name: 'Conformance', email: 'conformance@make.fun' }, committer: { name: 'Conformance', email: 'conformance@make.fun' } },
      });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  sendError(res, 404, 'Not Found');
}

/** The tree oid at a directory path inside a root tree, or null. */
function treeAtPath(repo: Repo, rootTreeOid: string, path: string): string | null {
  const parts = path.split('/').filter(Boolean);
  let current = rootTreeOid;
  for (const part of parts) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

function commitShape(store: Store, repo: Repo, oid: string, commit: ReturnType<typeof parseCommit>): Record<string, unknown> {
  const owner = store.repoOwner(repo);
  const authorName = commit.author.replace(/ <.*$/, '');
  const committerName = commit.committer.replace(/ <.*$/, '');
  return {
    sha: oid,
    node_id: b64(`Commit:${oid}`),
    commit: {
      author: { name: authorName, email: 'conformance@make.fun', date: tsFor(0) },
      committer: { name: committerName, email: 'conformance@make.fun', date: tsFor(0) },
      message: commit.message,
      tree: { sha: commit.tree },
      url: `/repos/${owner}/${repo.name}/git/commits/${oid}`,
      comment_count: 0,
    },
    author: userShape(owner),
    committer: userShape(owner),
    parents: commit.parents.map((p) => ({ sha: p, url: `/repos/${owner}/${repo.name}/commits/${p}` })),
    html_url: `https://github.com/${owner}/${repo.name}/commit/${oid}`,
    url: `/repos/${owner}/${repo.name}/commits/${oid}`,
  };
}

function contentShape(store: Store, repo: Repo, filePath: string, sha: string, data: Buffer): Record<string, unknown> {
  const owner = store.repoOwner(repo);
  const name = filePath.split('/').pop() ?? filePath;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path: filePath,
    content: data.toString('base64'),
    sha,
    url: `/repos/${owner}/${repo.name}/contents/${filePath}`,
    html_url: `https://github.com/${owner}/${repo.name}/blob/main/${filePath}`,
    git_url: `/repos/${owner}/${repo.name}/git/blobs/${sha}`,
    download_url: `https://raw.githubusercontent.com/${owner}/${repo.name}/main/${filePath}`,
    _links: { self: `/repos/${owner}/${repo.name}/contents/${filePath}`, git: `/repos/${owner}/${repo.name}/git/blobs/${sha}`, html: `https://github.com/${owner}/${repo.name}/blob/main/${filePath}` },
  };
}

function hashBlob(data: Buffer): string {
  const header = Buffer.from(`blob ${data.length}\u0000`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}
