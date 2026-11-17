import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { buildScenario } from './wire.ts';
import { commitParents, commitTree, gitObjectHash, type GitObject, type GitRepository } from './git.ts';

export interface Issue {
  id: number; number: number; title: string; body: string; state: string; labels: Label[]; comments: number;
}
export interface PullRequest {
  id: number; number: number; title: string; body: string; state: string; head: string; base: string;
  headsha: string; basesha: string; mergeable: boolean; merge_commit_sha: string | null; files: any[];
}
export interface Label { id: number; name: string; color: string; description: string | null }
export interface Repository extends GitRepository {
  owner: string; name: string; id: number; description: string; private: boolean;
  issues: Issue[]; pulls: PullRequest[]; labels: Label[]; comments: Map<number, any[]>;
  files: Map<string, { data: Buffer; sha: string }>;
}

export const scenario = buildScenario();
export const viewer = scenario.viewer.login;
export const token = process.env.MAKEFUN_SHOP_TOKEN || '';
export const now = process.env.MAKEFUN_TRIAL_NOW || '2025-01-01T00:00:00Z';
export const repositories = new Map<string, Repository>();
let nextId = 1;
export const keyOf = (owner: string, name: string) => (owner || '').toLowerCase() + '/' + (name || '').toLowerCase();
export const getRepo = (owner: string, name: string) => repositories.get(keyOf(owner, name));

export function makeRepo(owner: string, name: string, options: any = {}): Repository {
  const repo: Repository = {
    owner, name, id: nextId++, description: options.description || '', private: !!options.private,
    refs: new Map(), objects: new Map(), branches: new Map(), issues: [], pulls: [], labels: [],
    comments: new Map(), files: new Map(),
  };
  repositories.set(keyOf(owner, name), repo);
  return repo;
}

export function allocateId(): number { return nextId++; }
export function setNextId(value: number): void { nextId = value; }
export const contentHash = (value: Buffer | string) => createHash('sha1').update(value).digest('hex');

export function listFiles(repo: Repository, tree: string, prefix = '', output = new Map<string, string>()): Map<string, string> {
  const object = repo.objects.get(tree);
  if (!object || object.type !== 'tree') return output;
  const data = object.data; let cursor = 0;
  while (cursor < data.length) {
    const space = data.indexOf(32, cursor), zero = data.indexOf(0, space);
    if (space < 0 || zero < 0 || zero + 21 > data.length) break;
    const name = data.toString('utf8', space + 1, zero), sha = data.subarray(zero + 1, zero + 21).toString('hex');
    const mode = data.toString('ascii', cursor, space); cursor = zero + 21;
    if (mode === '40000') listFiles(repo, sha, prefix + name + '/', output);
    else output.set(prefix + name, sha);
  }
  return output;
}

export function buildTree(repo: Repository, files: Map<string, string>): string {
  const entries: Array<{ name: string; sha: string; mode: string }> = [];
  const directories = new Map<string, Map<string, string>>();
  for (const [path, sha] of files) {
    const slash = path.indexOf('/');
    if (slash < 0) entries.push({ name: path, sha, mode: '100644' });
    else {
      const name = path.slice(0, slash), children = directories.get(name) || new Map<string, string>();
      children.set(path.slice(slash + 1), sha); directories.set(name, children);
    }
  }
  for (const [name, children] of directories) entries.push({ name, sha: buildTree(repo, children), mode: '40000' });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const data = Buffer.concat(entries.map((entry) => Buffer.concat([Buffer.from(entry.mode + ' ' + entry.name + '\0'), Buffer.from(entry.sha, 'hex')])));
  const sha = gitObjectHash('tree', data); repo.objects.set(sha, { type: 'tree', data }); return sha;
}

export function makeCommit(repo: Repository, message: string, tree: string, parent = '', branch = 'main'): string {
  const data = Buffer.from('tree ' + tree + '\n' + (parent ? 'parent ' + parent + '\n' : '') +
    'author Forge <forge@example.invalid> 1735689600 +0000\ncommitter Forge <forge@example.invalid> 1735689600 +0000\n\n' + message + '\n');
  const sha = gitObjectHash('commit', data); repo.objects.set(sha, { type: 'commit', data });
  repo.refs.set('refs/heads/' + branch, sha); repo.branches.set(branch, sha); return sha;
}

export function updateFile(repo: Repository, path: string, data: Buffer, message: string, branch = 'main'): string {
  const parent = repo.branches.get(branch) || '', files = listFiles(repo, commitTree(repo, parent));
  const blob = gitObjectHash('blob', data); repo.objects.set(blob, { type: 'blob', data }); files.set(path, blob);
  const commit = makeCommit(repo, message, buildTree(repo, files), parent, branch);
  repo.files.set(path, { data, sha: blob }); return commit;
}

export function removeFile(repo: Repository, path: string, message: string, branch = 'main'): string {
  const parent = repo.branches.get(branch) || '', files = listFiles(repo, commitTree(repo, parent));
  files.delete(path); const commit = makeCommit(repo, message, buildTree(repo, files), parent, branch); repo.files.delete(path); return commit;
}

export function repositoryJson(repo: Repository): any {
  return { id: repo.id, node_id: Buffer.from('Repository:' + repo.id).toString('base64'), name: repo.name,
    full_name: repo.owner + '/' + repo.name, owner: { login: repo.owner }, private: repo.private,
    description: repo.description, default_branch: 'main', has_issues: true, hasIssuesEnabled: true,
    created_at: now, updated_at: now };
}
export function issueJson(repo: Repository, issue: Issue): any {
  return { ...issue, node_id: Buffer.from('Issue:' + repo.id + ':' + issue.number).toString('base64'),
    user: { login: repo.owner }, created_at: now, updated_at: now, closed_at: issue.state === 'closed' ? now : null };
}
export function pullJson(repo: Repository, pull: PullRequest): any {
  return { ...pull, node_id: Buffer.from('PullRequest:' + repo.id + ':' + pull.number).toString('base64'),
    head: { ref: pull.head, sha: pull.headsha, user: { login: repo.owner }, repo: repositoryJson(repo) },
    base: { ref: pull.base, sha: pull.basesha, user: { login: repo.owner }, repo: repositoryJson(repo) },
    merged: pull.state === 'closed', mergeable_state: pull.mergeable ? 'clean' : 'dirty',
    merged_at: pull.state === 'closed' ? now : null, created_at: now, updated_at: now };
}
export function addIssue(repo: Repository, body: any): Issue {
  const issue: Issue = { id: allocateId(), number: repo.issues.length + 1, title: String(body.title || ''),
    body: String(body.body || ''), state: 'open', labels: [], comments: 0 };
  for (const entry of body.labels || []) { const name = typeof entry === 'string' ? entry : entry.name; const label = repo.labels.find((item) => item.name === name); if (label) issue.labels.push(label); }
  repo.issues.push(issue); return issue;
}

export function createPull(repo: Repository, body: any): PullRequest {
  const head = String(body.head || ''), base = String(body.base || 'main');
  const headSha = repo.branches.get(head) || repo.refs.get('refs/heads/' + head) || '';
  const baseSha = repo.branches.get(base) || repo.refs.get('refs/heads/' + base) || '';
  const pull: PullRequest = { id: allocateId(), number: repo.pulls.length + 1, title: body.title || '', body: body.body || '',
    state: 'open', head, base, headsha: headSha, basesha: baseSha, mergeable: true, merge_commit_sha: null, files: [] };
  const headFiles = listFiles(repo, commitTree(repo, headSha)), baseFiles = listFiles(repo, commitTree(repo, baseSha));
  for (const [path, sha] of headFiles) if (baseFiles.get(path) !== sha) pull.files.push({ filename: path, status: baseFiles.has(path) ? 'modified' : 'added', additions: 1, deletions: 0, changes: 1, patch: '@@ -0,0 +1 @@' });
  repo.pulls.push(pull); return pull;
}

function seedRepositories(): void {
  for (const seed of scenario.repos) {
    const repo = makeRepo(viewer, seed.name, { description: seed.description });
    repo.id = seed.id;
    (repo as Repository & { default_branch?: string }).default_branch = seed.defaultBranch;
  }
  // makeRepo consumed one serial for each seed; seeded public IDs do not move that counter.
  setNextId(scenario.repos.length + 1);
}
seedRepositories();
