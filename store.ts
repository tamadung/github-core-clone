// store.ts — the forge's in-memory store: repos, objects, refs, issues, pulls,
// labels and comments. No disk writes at request time; everything lives in Maps
// and is deterministic (timestamps derive from a sequence, never Date.now()).

import { buildCommit, buildTree, hashObject, parseCommit, parseTree } from './git.ts';
import type { GitObject } from './git.ts';
import { CONFORMANCE_IDENTITY, ZERO_OID } from './git.ts';

export const BASE_EPOCH = 1700000000;

export function tsFor(seq: number): string {
  return new Date((BASE_EPOCH + seq) * 1000).toISOString();
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: string;
  createdSeq: number;
  updatedSeq: number;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  user: string;
  createdSeq: number;
  updatedSeq: number;
  comments: Comment[];
}

export interface Repo {
  id: number;
  name: string;
  owner: string | null;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  issueSeq: number;
  pulls: Pull[];
  pullSeq: number;
  labels: Label[];
  labelSeq: number;
  commentSeq: number;
  // caches, invalidated on push / mutation
  advV0Up: Buffer | null;
  advRecv: Buffer | null;
  clonePack: Map<string, Buffer>;
  lsRefsCache: Map<string, Buffer>;
  issueJson: Map<number, Buffer>;
}

export const DEFAULT_LABELS: Array<{ name: string; color: string; description: string }> = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'duplicate', color: 'cfd3d7', description: 'This issue or pull request already exists' },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
  { name: 'invalid', color: 'e4e669', description: 'This doesn\'t seem right' },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'wontfix', color: 'ffffff', description: 'This will not be worked on' },
];

export class Store {
  viewer: string | null = null;
  repos: Repo[] = [];
  byName: Map<string, Repo> = new Map();
  seq = 0;
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextLabelId = 1;
  nextCommentId = 1;

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Learn the viewer's login from the first owner segment ever seen. */
  learnViewer(owner: string): boolean {
    if (!owner) return false;
    if (this.viewer === null) {
      this.viewer = owner;
      return true;
    }
    return this.viewer === owner;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: this.viewer,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      objects: new Map(),
      refs: new Map(),
      issues: [],
      issueSeq: 1,
      pulls: [],
      pullSeq: 1,
      labels: [],
      labelSeq: 1,
      commentSeq: 1,
      advV0Up: null,
      advRecv: null,
      clonePack: new Map(),
      lsRefsCache: new Map(),
      issueJson: new Map(),
    };
    for (const def of DEFAULT_LABELS) {
      repo.labels.push({ id: this.nextLabelId++, name: def.name, color: def.color, description: def.description });
    }
    this.repos.push(repo);
    this.byName.set(name, repo);
    return repo;
  }

  findRepoByName(name: string): Repo | undefined {
    return this.byName.get(name);
  }

  /**
   * Resolve a repo by (owner, name). When the viewer is still unknown, the
   * first owner-bearing request binds it. A stranger owner never resolves.
   */
  findRepo(owner: string, name: string): Repo | undefined {
    if (owner) {
      if (this.viewer === null) {
        this.viewer = owner;
      } else if (this.viewer !== owner) {
        return undefined;
      }
    }
    const repo = this.findRepoByName(name);
    if (!repo) return undefined;
    if (repo.owner === null) repo.owner = this.viewer;
    if (owner && repo.owner !== owner) return undefined;
    return repo;
  }

  repoOwner(repo: Repo): string {
    return repo.owner ?? this.viewer ?? '';
  }

  invalidateGitCaches(repo: Repo): void {
    repo.advV0Up = null;
    repo.advRecv = null;
    repo.clonePack.clear();
    repo.lsRefsCache.clear();
  }

  resolveRef(repo: Repo, ref: string): string | null {
    if (!ref) return null;
    if (/^[0-9a-f]{40}$/.test(ref)) return repo.objects.has(ref) ? ref : null;
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch) return branch;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag) return tag;
    if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    return null;
  }

  headOid(repo: Repo): string {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  }

  getOrCreateLabel(repo: Repo, name: string): Label {
    const existing = repo.labels.find((label) => label.name === name);
    if (existing) return existing;
    const label: Label = { id: this.nextLabelId++, name, color: 'ededed', description: '' };
    repo.labels.push(label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue {
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.issueSeq++,
      title,
      body,
      state: 'open',
      labels: labelNames.map((name) => this.getOrCreateLabel(repo, name)),
      user: this.viewer ?? '',
      createdSeq: this.nextSeq(),
      updatedSeq: this.seq,
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
    const headSha = this.resolveRef(repo, headRef);
    const baseSha = this.resolveRef(repo, baseRef);
    if (!headSha || !baseSha) return null;
    const pull: Pull = {
      id: this.nextPullId++,
      number: repo.pullSeq++,
      title,
      body,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      user: this.viewer ?? '',
      createdSeq: this.nextSeq(),
      updatedSeq: this.seq,
      comments: [],
    };
    repo.pulls.push(pull);
    return pull;
  }

  /** The tree oid at `path` inside `treeOid`, or null when absent. */
  blobAtPath(repo: Repo, treeOid: string, path: string): { oid: string; mode: string } | null {
    const parts = path.split('/').filter(Boolean);
    let current = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((e) => e.name === parts[i]);
      if (!entry) return null;
      if (i === parts.length - 1) {
        if (entry.mode === '40000') return null;
        return { oid: entry.oid, mode: entry.mode };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** Flat map of every file path -> {oid, mode} reachable from a tree. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') {
        for (const [p, v] of this.flattenTree(repo, entry.oid, path)) out.set(p, v);
      } else if (entry.mode !== '160000') {
        out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    }
    return out;
  }

  /** Count lines in a blob (a trailing newline does not make an extra line). */
  countLines(repo: Repo, oid: string): number {
    const object = repo.objects.get(oid);
    if (!object) return 0;
    const text = object.data.toString('utf8');
    if (!text) return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  }

  /**
   * The file diff between two trees: status added/modified/removed with a
   * line-count approximation of additions/deletions.
   */
  diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): Array<{
    filename: string;
    status: 'added' | 'modified' | 'removed';
    additions: number;
    deletions: number;
    changes: number;
  }> {
    const base = this.flattenTree(repo, baseTreeOid);
    const head = this.flattenTree(repo, headTreeOid);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const files: Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        const deletions = this.countLines(repo, b.oid);
        files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (!b && h) {
        const additions = this.countLines(repo, h.oid);
        files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b && h && b.oid !== h.oid) {
        const additions = this.countLines(repo, h.oid);
        const deletions = this.countLines(repo, b.oid);
        files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return files;
  }

  /**
   * Three-way mergeability: a PR conflicts when a file it changes was also
   * changed on the base tip (relative to the PR's base) with different content.
   */
  mergeable(pull: Pull, repo: Repo): boolean {
    const baseTipOid = this.resolveRef(repo, pull.baseRef);
    if (!baseTipOid) return false;
    const baseTip = repo.objects.get(baseTipOid);
    const head = repo.objects.get(pull.headSha);
    const base = repo.objects.get(pull.baseSha);
    if (!baseTip || baseTip.type !== 'commit' || !head || head.type !== 'commit' || !base || base.type !== 'commit') {
      return false;
    }
    const baseTipTree = parseCommit(baseTip.data).tree;
    const headTree = parseCommit(head.data).tree;
    const baseTree = parseCommit(base.data).tree;
    const prFiles = this.diffTrees(repo, baseTree, headTree);
    const baseTipFlat = this.flattenTree(repo, baseTipTree);
    const baseFlat = this.flattenTree(repo, baseTree);
    const headFlat = this.flattenTree(repo, headTree);
    for (const file of prFiles) {
      const inBase = baseFlat.get(file.filename);
      const inHead = headFlat.get(file.filename);
      const inTip = baseTipFlat.get(file.filename);
      const baseOid = inBase?.oid ?? null;
      const headOid = inHead?.oid ?? null;
      const tipOid = inTip?.oid ?? null;
      // Changed on base tip AND changed in the PR AND the two changes differ.
      if (baseOid !== tipOid && baseOid !== headOid && tipOid !== headOid) return false;
    }
    return true;
  }

  /**
   * Squash-merge a pull: one new commit on the base tip whose tree is the
   * head tree. Returns the merge commit oid, or null when it cannot merge.
   */
  mergePull(repo: Repo, pull: Pull): string | null {
    if (pull.merged || pull.state !== 'open') return null;
    if (!this.mergeable(pull, repo)) return null;
    const baseTipOid = this.resolveRef(repo, pull.baseRef);
    if (!baseTipOid) return null;
    const head = repo.objects.get(pull.headSha);
    if (!head || head.type !== 'commit') return null;
    const headTree = parseCommit(head.data).tree;
    const message = `Merge pull request #${pull.number} from ${this.repoOwner(repo)}/${pull.headRef}`;
    const commitData = buildCommit({
      tree: headTree,
      parents: [baseTipOid],
      message,
      author: CONFORMANCE_IDENTITY,
      committer: CONFORMANCE_IDENTITY,
      timestamp: BASE_EPOCH,
    });
    const oid = hashObject('commit', commitData);
    repo.objects.set(oid, { type: 'commit', data: commitData });
    repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
    pull.merged = true;
    pull.state = 'closed';
    pull.merged_at = tsFor(this.nextSeq());
    pull.merge_commit_sha = oid;
    pull.updatedSeq = this.seq;
    this.invalidateGitCaches(repo);
    return oid;
  }

  /**
   * Build a commit from a full tree path map: used by PUT /contents. Returns
   * the new commit oid. `message` is the commit message; `parent` is the
   * branch tip (null for the first commit).
   */
  commitFiles(
    repo: Repo,
    files: Map<string, { data: Buffer; mode: string }>,
    message: string,
    parent: string | null,
  ): string {
    // Build trees bottom-up: group files by directory.
    const byDir = new Map<string, Map<string, { oid: string; mode: string }>>();
    for (const [path, file] of files) {
      const blobOid = hashObject('blob', file.data);
      repo.objects.set(blobOid, { type: 'blob', data: file.data });
      const slash = path.lastIndexOf('/');
      const dir = slash < 0 ? '' : path.slice(0, slash);
      const name = slash < 0 ? path : path.slice(slash + 1);
      if (!byDir.has(dir)) byDir.set(dir, new Map());
      byDir.get(dir)!.set(name, { oid: blobOid, mode: file.mode });
    }
    const buildDir = (dir: string): string => {
      const entries: Array<{ mode: string; name: string; oid: string }> = [];
      const direct = byDir.get(dir);
      if (direct) {
        for (const [name, v] of direct) entries.push({ mode: v.mode, name, oid: v.oid });
      }
      // Subdirectories of this dir.
      const subdirs = new Set<string>();
      for (const key of byDir.keys()) {
        if (key === dir) continue;
        if (dir === '' && !key.includes('/')) subdirs.add(key);
        else if (key.startsWith(`${dir}/`) && !key.slice(dir.length + 1).includes('/')) subdirs.add(key);
      }
      for (const sub of subdirs) {
        const name = dir === '' ? sub : sub.slice(dir.length + 1);
        entries.push({ mode: '40000', name, oid: buildDir(sub) });
      }
      const treeData = buildTree(entries);
      const treeOid = hashObject('tree', treeData);
      repo.objects.set(treeOid, { type: 'tree', data: treeData });
      return treeOid;
    };
    const rootTree = buildDir('');
    const commitData = buildCommit({
      tree: rootTree,
      parents: parent ? [parent] : [],
      message,
      author: CONFORMANCE_IDENTITY,
      committer: CONFORMANCE_IDENTITY,
      timestamp: BASE_EPOCH,
    });
    const commitOid = hashObject('commit', commitData);
    repo.objects.set(commitOid, { type: 'commit', data: commitData });
    return commitOid;
  }

  /** The full file map of a tree (used by PUT /contents on top of an existing tree). */
  treeFileMap(repo: Repo, treeOid: string): Map<string, { data: Buffer; mode: string }> {
    const out = new Map<string, { data: Buffer; mode: string }>();
    for (const [path, entry] of this.flattenTree(repo, treeOid)) {
      const object = repo.objects.get(entry.oid);
      if (object) out.set(path, { data: object.data, mode: entry.mode });
    }
    return out;
  }

  /** Commits reachable from `ref`, newest-first (topological order via DFS). */
  commitsFrom(repo: Repo, ref: string): Array<{ oid: string; commit: ReturnType<typeof parseCommit> }> {
    const tip = this.resolveRef(repo, ref);
    if (!tip) return [];
    const out: Array<{ oid: string; commit: ReturnType<typeof parseCommit> }> = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ oid, commit });
      for (const parent of commit.parents) stack.push(parent);
    }
    return out;
  }
}
