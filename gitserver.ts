// gitserver.ts — the git smart-HTTP surface: ref advertisement (protocol v0
// and v2), upload-pack (fetch, ls-refs, shallow) and receive-pack (push with
// report-status). Every byte follows the git wire format the conformance
// client parses; see git.ts for the primitives.

import type { ServerResponse } from 'node:http';
import {
  collectReachable,
  collectReachableDepth,
  decodePktLines,
  encodePktLines,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  sidebandChunks,
  writePack,
  ZERO_OID,
} from './git.ts';
import type { GitObject } from './git.ts';
import type { Repo, Store } from './store.ts';

const AGENT = 'forge/1.0';

const UPLOAD_V0_CAPS =
  'symref=HEAD:refs/heads/main multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=forge/1.0';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

const V2_ADVERTISEMENT = encodePktLines([
  'version 2\n',
  `agent=${AGENT}\n`,
  'ls-refs=unborn\n',
  'fetch=shallow\n',
  'object-format=sha1\n',
  'flush',
]);

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** Resolve a tag object to its ultimate commit, or null when it is not a tag. */
function peeledTarget(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  let current = parseTag(object.data).object;
  for (let i = 0; i < 16; i += 1) {
    const next = repo.objects.get(current);
    if (!next) return null;
    if (next.type === 'commit') return current;
    if (next.type === 'tag') {
      current = parseTag(next.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** A v0 ref advertisement for one service, with the `# service=` preamble. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`];
  const refs = sortedRefs(repo);
  if (!refs.length) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${caps}\n`);
  } else {
    const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? refs[0].oid;
    lines.push(`${head} HEAD\u0000${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const peeled = ref.name.startsWith('refs/tags/') ? peeledTarget(repo, ref.oid) : null;
      if (peeled) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length });
  res.end(body);
}

function send404(res: ServerResponse): void {
  sendBuffer(res, 404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'));
}

// ---------------------------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------------------------

export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string | undefined,
  res: ServerResponse,
): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    send404(res);
    return;
  }
  const repo = store.findRepo(owner, repoName);
  if (!repo) {
    send404(res);
    return;
  }
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', V2_ADVERTISEMENT);
    return;
  }
  const cache = service === 'git-upload-pack' ? repo.advV0Up : repo.advRecv;
  if (cache) {
    sendBuffer(res, 200, `application/x-${service}-advertisement`, cache);
    return;
  }
  const body = v0Advertisement(repo, service);
  if (service === 'git-upload-pack') repo.advV0Up = body;
  else repo.advRecv = body;
  sendBuffer(res, 200, `application/x-${service}-advertisement`, body);
}

// ---------------------------------------------------------------------------------------------
// upload-pack v2: ls-refs and fetch
// ---------------------------------------------------------------------------------------------

interface V2Request {
  command: string;
  args: string[];
}

function parseV2Body(body: Buffer): V2Request {
  const packets = decodePktLines(body);
  let command = '';
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!afterDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length).replace(/\n$/, '');
    } else {
      args.push(line.replace(/\n$/, ''));
    }
  }
  return { command, args };
}

function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  const cacheKey = args.join('|');
  const cached = repo.lsRefsCache.get(cacheKey);
  if (cached) return cached;
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: Array<string | 'flush'> = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (keep('HEAD')) {
    if (headOid) {
      lines.push(symrefs ? `${headOid} HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `${headOid} HEAD\n`);
    } else if (unborn) {
      lines.push(symrefs ? `unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : 'unborn HEAD\n');
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (ref.name === `refs/heads/${repo.defaultBranch}` && symrefs) {
      // The default branch is already advertised through HEAD; keep it plain.
    }
    if (peel && ref.name.startsWith('refs/tags/')) {
      const peeled = peeledTarget(repo, ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  const out = encodePktLines(lines);
  repo.lsRefsCache.set(cacheKey, out);
  return out;
}

interface FetchPlan {
  wants: string[];
  wantRefs: Array<{ ref: string; oid: string }>;
  haves: string[];
  oldShallow: string[];
  depth: number | null;
}

function planFetch(repo: Repo, args: string[]): FetchPlan {
  const wants: string[] = [];
  const wantRefs: Array<{ ref: string; oid: string }> = [];
  const haves: string[] = [];
  const oldShallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) {
      const oid = arg.slice(5).trim();
      if (isObjectId(oid)) wants.push(oid);
    } else if (arg.startsWith('want-ref ')) {
      const ref = arg.slice('want-ref '.length).trim();
      const oid = repo.refs.get(ref);
      if (oid) {
        wantRefs.push({ ref, oid });
        wants.push(oid);
      }
    } else if (arg.startsWith('have ')) {
      const oid = arg.slice(5).trim();
      if (isObjectId(oid)) haves.push(oid);
    } else if (arg.startsWith('shallow ')) {
      const oid = arg.slice(8).trim();
      if (isObjectId(oid)) oldShallow.push(oid);
    } else if (arg.startsWith('deepen ')) {
      const n = parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  return { wants, wantRefs, haves, oldShallow, depth };
}

/**
 * Objects the client already holds, from its `have` lines — but a shallow
 * clone holds only the boundary commits themselves (plus their trees and
 * blobs), never their parents. `stopAt` names those boundary commits, so a
 * deepen fetch still delivers the parent commits it is asking for.
 */
function collectHeld(repo: Repo, haves: string[], stopAt: Set<string>): Set<string> {
  const held = new Set<string>();
  const queue = [...haves];
  while (queue.length) {
    const oid = queue.pop()!;
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!stopAt.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return held;
}

function fetchPackSet(repo: Repo, plan: FetchPlan): { objects: GitObject[]; boundary: string[]; unshallow: string[] } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  let included: Set<string>;
  let boundary: string[] = [];
  if (plan.depth != null) {
    const result = collectReachableDepth(plan.wants, lookup, plan.depth);
    included = result.included;
    boundary = result.boundary;
  } else {
    included = collectReachable(plan.wants, lookup, { allowMissing: true });
  }
  if (plan.haves.length) {
    const held = collectHeld(repo, plan.haves, new Set(plan.oldShallow));
    for (const oid of held) included.delete(oid);
  }
  const objects: GitObject[] = [];
  for (const oid of included) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  const unshallow: string[] = [];
  if (plan.oldShallow.length) {
    const boundarySet = new Set(boundary);
    for (const old of plan.oldShallow) {
      if (included.has(old) && !boundarySet.has(old)) unshallow.push(old);
    }
  }
  return { objects, boundary, unshallow };
}

/** The pack for a fetch plan, cached per repo: clones of the same tip repeat. */
function packForFetch(repo: Repo, plan: FetchPlan, objects: GitObject[]): Buffer {
  const key = `${plan.wants.slice().sort().join(',')}|${plan.depth ?? ''}|${plan.haves.slice().sort().join(',')}|${plan.oldShallow.slice().sort().join(',')}`;
  const cached = repo.clonePack.get(key);
  if (cached) return cached;
  const pack = writePack(objects);
  repo.clonePack.set(key, pack);
  return pack;
}

function fetchV2Response(repo: Repo, plan: FetchPlan): Buffer {
  const { objects, boundary, unshallow } = fetchPackSet(repo, plan);
  const parts: Buffer[] = [];
  const ackLines: string[] = [];
  if (plan.haves.length) {
    let acked = false;
    for (const have of plan.haves) {
      if (repo.objects.has(have)) {
        ackLines.push(`ACK ${have}\n`);
        acked = true;
      }
    }
    if (!acked) ackLines.push('NAK\n');
    else ackLines.push('ready\n');
  } else {
    ackLines.push('NAK\n');
  }
  parts.push(encodePktLines(['acknowledgments\n', ...ackLines, 'delim']));
  if (plan.wantRefs.length) {
    const lines = ['wanted-refs\n', ...plan.wantRefs.map((w) => `${w.oid} ${w.ref}\n`), 'delim'];
    parts.push(encodePktLines(lines));
  }
  if (plan.depth != null || unshallow.length) {
    const lines = [
      'shallow-info\n',
      ...boundary.map((oid) => `shallow ${oid}\n`),
      ...unshallow.map((oid) => `unshallow ${oid}\n`),
      'delim',
    ];
    parts.push(encodePktLines(lines));
  }
  parts.push(encodePktLines(['packfile\n']));
  const pack = packForFetch(repo, plan, objects);
  for (const chunk of sidebandChunks(1, pack)) parts.push(chunk);
  parts.push(Buffer.from('0000'));
  return Buffer.concat(parts);
}

function fetchV0Response(repo: Repo, plan: FetchPlan): Buffer {
  const { objects, boundary, unshallow } = fetchPackSet(repo, plan);
  const parts: Buffer[] = [];
  const ackLines: string[] = [];
  if (plan.haves.length) {
    let acked = false;
    for (const have of plan.haves) {
      if (repo.objects.has(have)) {
        ackLines.push(`ACK ${have}\n`);
        acked = true;
      }
    }
    if (!acked) ackLines.push('NAK\n');
  } else {
    ackLines.push('NAK\n');
  }
  for (const oid of boundary) ackLines.push(`shallow ${oid}\n`);
  for (const oid of unshallow) ackLines.push(`unshallow ${oid}\n`);
  parts.push(encodePktLines(ackLines));
  const pack = packForFetch(repo, plan, objects);
  for (const chunk of sidebandChunks(1, pack)) parts.push(chunk);
  parts.push(Buffer.from('0000'));
  return Buffer.concat(parts);
}

export function handleUploadPack(
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocol: string | undefined,
  res: ServerResponse,
): void {
  const repo = store.findRepo(owner, repoName);
  if (!repo) {
    send404(res);
    return;
  }
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    sendBuffer(res, 400, 'text/plain', Buffer.from('malformed pkt-line stream', 'utf8'));
    return;
  }
  const firstText = packets.find((p) => p.kind === 'data')?.payload.toString('utf8') ?? '';
  const isV2 = gitProtocol === 'version=2' || firstText.startsWith('command=');
  if (isV2) {
    let request: V2Request;
    try {
      request = parseV2Body(body);
    } catch {
      sendBuffer(res, 400, 'text/plain', Buffer.from('malformed pkt-line stream', 'utf8'));
      return;
    }
    if (request.command === 'ls-refs') {
      const out = lsRefsResponse(repo, request.args);
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', out);
      return;
    }
    if (request.command === 'fetch') {
      const plan = planFetch(repo, request.args);
      const out = fetchV2Response(repo, plan);
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', out);
      return;
    }
    sendBuffer(res, 400, 'text/plain', Buffer.from(`unknown command ${request.command}`, 'utf8'));
    return;
  }
  // Protocol v0 fetch: want/have/deepen/shallow lines in one or two sections.
  const args: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const plan = planFetch(repo, args);
  const out = fetchV0Response(repo, plan);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', out);
}

// ---------------------------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------------------------

export function handleReceivePack(
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
  res: ServerResponse,
): void {
  const repo = store.findRepo(owner, repoName);
  if (!repo) {
    send404(res);
    return;
  }
  // Split the body: pkt-line command section (up to the first flush), then the pack.
  let packStart = body.length;
  let offset = 0;
  const commandLines: string[] = [];
  let malformed = false;
  try {
    while (offset < body.length) {
      if (offset + 4 > body.length) {
        malformed = true;
        break;
      }
      const length = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
      if (Number.isNaN(length) || length < 0) {
        malformed = true;
        break;
      }
      if (length === 0) {
        packStart = offset + 4;
        break;
      }
      if (offset + length > body.length) {
        malformed = true;
        break;
      }
      commandLines.push(body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, ''));
      offset += length;
    }
  } catch {
    malformed = true;
  }

  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  let sideband = false;
  if (!malformed) {
    for (let i = 0; i < commandLines.length; i += 1) {
      let line = commandLines[i];
      if (i === 0) {
        const nul = line.indexOf('\u0000');
        if (nul >= 0) {
          const caps = line.slice(nul + 1);
          if (caps.split(' ').includes('side-band-64k')) sideband = true;
          line = line.slice(0, nul);
        }
      }
      const parts = line.split(' ');
      if (parts.length !== 3 || !isObjectId(parts[0]) || !isObjectId(parts[1])) {
        malformed = true;
        break;
      }
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }

  const reportLines: string[] = [];
  let unpackOk = true;
  if (malformed || !commands.length) {
    unpackOk = false;
    reportLines.push('unpack error\n');
    for (const command of commands) reportLines.push(`ng ${command.ref} unpacker error\n`);
  } else {
    const packBytes = body.subarray(packStart);
    const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
    if (needsPack && packBytes.length > 0) {
      try {
        const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
        for (const [oid, object] of read.objects) repo.objects.set(oid, object);
      } catch {
        unpackOk = false;
        reportLines.push('unpack error\n');
        for (const command of commands) reportLines.push(`ng ${command.ref} unpacker error\n`);
      }
    }
    if (unpackOk) {
      reportLines.push('unpack ok\n');
      let changed = false;
      for (const command of commands) {
        const current = repo.refs.get(command.ref);
        if (command.newOid === ZERO_OID) {
          // Delete.
          if (!current) {
            reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
          } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
            reportLines.push(`ng ${command.ref} non-fast-forward\n`);
          } else {
            repo.refs.delete(command.ref);
            changed = true;
            reportLines.push(`ok ${command.ref}\n`);
          }
          continue;
        }
        const target = repo.objects.get(command.newOid);
        if (!target) {
          reportLines.push(`ng ${command.ref} object not found\n`);
          continue;
        }
        if (command.ref.startsWith('refs/heads/') && target.type !== 'commit') {
          reportLines.push(`ng ${command.ref} not a commit\n`);
          continue;
        }
        if (command.ref.startsWith('refs/tags/') && target.type !== 'commit' && target.type !== 'tag') {
          reportLines.push(`ng ${command.ref} not a commit or tag\n`);
          continue;
        }
        if (!current) {
          if (command.oldOid !== ZERO_OID) {
            reportLines.push(`ng ${command.ref} non-fast-forward\n`);
            continue;
          }
          repo.refs.set(command.ref, command.newOid);
          changed = true;
          reportLines.push(`ok ${command.ref}\n`);
          continue;
        }
        if (command.oldOid !== current) {
          reportLines.push(`ng ${command.ref} non-fast-forward\n`);
          continue;
        }
        if (!isAncestor(current, command.newOid, (oid) => repo.objects.get(oid))) {
          reportLines.push(`ng ${command.ref} non-fast-forward\n`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        changed = true;
        reportLines.push(`ok ${command.ref}\n`);
      }
      if (changed) store.invalidateGitCaches(repo);
    }
  }

  const inner = encodePktLines(reportLines);
  let out: Buffer;
  if (sideband) {
    const parts: Buffer[] = [];
    for (const chunk of sidebandChunks(1, inner)) parts.push(chunk);
    parts.push(Buffer.from('0000'));
    out = Buffer.concat(parts);
  } else {
    out = inner;
  }
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', out);
}
