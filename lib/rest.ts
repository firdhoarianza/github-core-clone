import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  addIssue, allocateId, buildTree, createPull, getRepo, issueJson, keyOf, listFiles,
  makeRepo, now, pullJson, removeFile, repositories, repositoryJson, scenario, viewer,
  type Repository,
} from './store.ts';
import { commitParents, commitTree, gitObjectHash } from './git.ts';

type JsonSender = (response: ServerResponse, status: number, body: any, headers?: Record<string, string>) => void;
type ErrorSender = (response: ServerResponse, status: number, message: string) => void;

export function pathParts(pathname: string): string[] {
  return pathname.replace(/^\/api\/v3\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
}

export function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, body: any, send: JsonSender, fail: ErrorSender): void {
  const method = req.method || 'GET';
  const origin = 'http://' + (req.headers.host || 'localhost');
  const parts = pathParts(url.pathname);
  if (!parts.length) return send(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  if (parts[0] === 'meta') return send(res, 200, { installed_version: '3.0.0' });
  if (parts[0] === 'user') {
    if (!parts[1]) return send(res, 200, { login: viewer, id: scenario.viewer.id });
    if (parts[1] === 'repos') {
      if (method === 'POST') {
        if (!body?.name) return fail(res, 422, 'name is required');
        if (getRepo(viewer, body.name)) return fail(res, 422, 'name already exists');
        return send(res, 201, repositoryJson(makeRepo(viewer, body.name, body)));
      }
      if (method === 'GET') {
        const rows = [...repositories.values()].filter((repo) => repo.owner === viewer);
        const page = +(url.searchParams.get('page') || 1), perPage = Math.min(100, +(url.searchParams.get('per_page') || 30));
        const headers: Record<string, string> = {};
        if (page * perPage < rows.length) headers.link = '<' + origin + '/api/v3/user/repos?per_page=' + perPage + '&page=' + (page + 1) + '>; rel="next"';
        return send(res, 200, rows.slice((page - 1) * perPage, page * perPage).map(repositoryJson), headers);
      }
    }
  }
  if (parts.length < 2) return fail(res, 404, 'Not Found');
  const [, owner, name, ...resource] = parts;
  const repo = getRepo(owner!, name!);
  if (!repo || owner !== viewer) return fail(res, 404, 'Not Found');
  if (!resource.length) {
    if (method === 'GET') return send(res, 200, repositoryJson(repo));
    if (method === 'PATCH') { if ('description' in (body || {})) repo.description = body.description; return send(res, 200, repositoryJson(repo)); }
    if (method === 'DELETE') { repositories.delete(keyOf(owner!, name!)); return send(res, 204, null); }
    return fail(res, 405, 'Method Not Allowed');
  }
  if (resource[0] === 'branches' && method === 'GET') return send(res, 200, [...repo.branches].map(([branch, sha]) => ({ name: branch, commit: { sha } })));
  if (resource[0] === 'commits' && method === 'GET') {
    let commit = url.searchParams.get('sha') || 'main';
    commit = repo.branches.get(commit) || repo.refs.get('refs/heads/' + commit) || '';
    const rows: any[] = [], seen = new Set<string>();
    while (commit && !seen.has(commit) && rows.length < 100) {
      seen.add(commit); const object = repo.objects.get(commit); if (!object) break;
      rows.push({ sha: commit, commit: { message: object.data.toString().split('\n\n').slice(1).join('\n\n').trim() }, parents: commitParents(object).map((sha) => ({ sha })) });
      commit = commitParents(object)[0] || '';
    }
    return send(res, 200, rows);
  }
  if (resource[0] === 'git' && resource[1] === 'refs' && method === 'POST') {
    let ref = String(body.ref || 'refs/heads/main'); const sha = body.sha || body.object?.sha;
    if (!ref.startsWith('refs/')) ref = 'refs/heads/' + ref;
    if (!sha) return fail(res, 422, 'sha required');
    repo.refs.set(ref, sha); if (ref.startsWith('refs/heads/')) repo.branches.set(ref.slice(11), sha);
    return send(res, 201, { ref, object: { sha, type: 'commit' } });
  }
  if (resource[0] === 'contents') return contents(repo, resource.slice(1), method, url, body, res, send, fail);
  if (resource[0] === 'labels') {
    if (method === 'POST') { const label = { id: allocateId(), name: String(body.name || ''), color: body.color || 'ededed', description: body.description || null }; repo.labels.push(label); return send(res, 201, label); }
    if (method === 'GET') return send(res, 200, repo.labels);
  }
  if (resource[0] === 'issues') return issues(repo, resource.slice(1), method, url, body, res, send, fail);
  if (resource[0] === 'pulls') return pulls(repo, resource.slice(1), method, url, body, res, send, fail);
  return fail(res, 404, 'Not Found');
}

function contents(repo: Repository, pathPartsValue: string[], method: string, url: URL, body: any, res: ServerResponse, send: JsonSender, fail: ErrorSender): void {
  const path = decodeURIComponent(pathPartsValue.join('/'));
  const branch = body?.branch || url.searchParams.get('ref') || 'main';
  const tip = repo.branches.get(branch) || repo.refs.get('refs/heads/' + branch) || repo.branches.get('main') || '';
  const files = listFiles(repo, commitTree(repo, tip));
  if (method === 'GET') {
    const sha = files.get(path);
    if (sha) {
      const data = repo.objects.get(sha)?.data || Buffer.alloc(0);
      return send(res, 200, { name: path.split('/').pop(), path, sha, size: data.length, type: 'file', encoding: 'base64', content: data.toString('base64') });
    }
    const prefix = path ? path + '/' : '';
    const entries = [...files].filter(([name]) => name.startsWith(prefix) && !name.slice(prefix.length).includes('/')).map(([name, hash]) => ({ name: name.slice(prefix.length), path: name, sha: hash, size: (repo.objects.get(hash)?.data || Buffer.alloc(0)).length, type: 'file' }));
    return entries.length ? send(res, 200, entries) : fail(res, 404, 'Not Found');
  }
  if (method === 'PUT') {
    const current = files.get(path), data = Buffer.from(body.content || '', 'base64');
    if (body.sha && current && body.sha !== current || body.sha && !current) return fail(res, 409, 'sha does not match');
    const sha = gitObjectHash('blob', data), commit = updateContent(repo, path, data, body.message || 'Update ' + path, branch);
    return send(res, current ? 200 : 201, { content: { name: path.split('/').pop(), path, sha, size: data.length, encoding: 'base64' }, commit: { sha: commit } });
  }
  if (method === 'DELETE') {
    if (!files.has(path)) return fail(res, 404, 'Not Found');
    return send(res, 200, { commit: { sha: removeFile(repo, path, body.message || 'Delete ' + path, branch) } });
  }
}

import { updateFile as updateContent } from './store.ts';

function issues(repo: Repository, path: string[], method: string, url: URL, body: any, res: ServerResponse, send: JsonSender, fail: ErrorSender): void {
  if (!path.length) {
    if (method === 'POST') {
      if ((body.labels || []).some((entry: any) => !repo.labels.some((label) => label.name === (typeof entry === 'string' ? entry : entry.name)))) return send(res, 422, { message: 'Validation Failed', errors: [{ field: 'labels' }] });
      return send(res, 201, issueJson(repo, addIssue(repo, body)));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') || 'open'; let rows = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      if (url.searchParams.get('sort') === 'created') rows = rows.slice().sort((a, b) => (a.number - b.number) * (url.searchParams.get('direction') === 'asc' ? 1 : -1));
      return send(res, 200, rows.map((issue) => issueJson(repo, issue)));
    }
  }
  const issue = repo.issues.find((item) => item.number === +path[0]!);
  if (!issue) return fail(res, 404, 'Not Found');
  if (path[1] === 'comments') {
    const rows = repo.comments.get(issue.number) || [];
    if (method === 'POST') { const comment = { id: allocateId(), body: body.body || '', user: { login: viewer }, created_at: now }; rows.push(comment); repo.comments.set(issue.number, rows); issue.comments += 1; return send(res, 201, comment); }
    if (method === 'GET') return send(res, 200, rows);
  }
  if (method === 'GET') return send(res, 200, issueJson(repo, issue));
  if (method === 'PATCH') { if (body.state) issue.state = body.state; return send(res, 200, issueJson(repo, issue)); }
}

function pulls(repo: Repository, path: string[], method: string, url: URL, body: any, res: ServerResponse, send: JsonSender, fail: ErrorSender): void {
  if (!path.length) {
    if (method === 'POST') return send(res, 201, pullJson(repo, createPull(repo, body)));
    if (method === 'GET') { const state = url.searchParams.get('state') || 'open'; return send(res, 200, repo.pulls.filter((pull) => state === 'all' || pull.state === state).map((pull) => pullJson(repo, pull))); }
  }
  const pull = repo.pulls.find((item) => item.number === +path[0]!);
  if (!pull) return fail(res, 404, 'Not Found');
  if (path[1] === 'files') return send(res, 200, pull.files);
  if (path[1] === 'merge' && method === 'PUT') {
    const baseTip = repo.branches.get(pull.base) || repo.refs.get('refs/heads/' + pull.base) || pull.basesha;
    const baseFiles = listFiles(repo, commitTree(repo, baseTip)), headFiles = listFiles(repo, commitTree(repo, pull.headsha)), originalBase = listFiles(repo, commitTree(repo, pull.basesha));
    const changed = [...headFiles].filter(([name, sha]) => originalBase.get(name) !== sha).map(([name]) => name);
    const conflict = !!baseTip && baseTip !== pull.basesha && changed.some((name) => baseFiles.has(name) && baseFiles.get(name) !== originalBase.get(name));
    if (conflict || !pull.mergeable) return fail(res, 405, 'Pull Request is not mergeable');
    const merged = new Map(baseFiles); for (const [name, sha] of headFiles) merged.set(name, sha);
    const commit = makeMergedCommit(repo, pull.title + ' (#' + pull.number + ')', buildTree(repo, merged), baseTip, pull.base || 'main');
    pull.state = 'closed'; pull.mergeable = false; pull.merge_commit_sha = commit; pull.basesha = baseTip;
    return send(res, 200, { sha: commit, merged: true, message: 'Pull Request successfully merged' });
  }
  if (method === 'GET') return send(res, 200, pullJson(repo, pull));
}

import { makeCommit as makeMergedCommit } from './store.ts';
