import {
  addIssue, allocateId, getRepo, makeCommit, makeRepo, now, repositories, scenario, viewer,
  type Repository,
} from './store.ts';
import { buildTree, listFiles } from './store.ts';

const encodeId = (type: string, id: number) => Buffer.from(type + ':' + id).toString('base64');
const repositoryForId = (value: string): Repository | undefined => [...repositories.values()].find((repo) => encodeId('Repository', repo.id) === value);
const fields: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'labels', 'author', 'comments', 'repository', 'createdAt', 'updatedAt', 'closedAt'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'description', 'isPrivate', 'url'],
};

function issueNode(repo: Repository, issue: any): any {
  return { id: encodeId('Issue', issue.id), databaseId: issue.id, number: issue.number, title: issue.title,
    body: issue.body, state: issue.state.toUpperCase(), labels: { nodes: issue.labels }, author: { login: repo.owner } };
}
function pullNode(pull: any, query: string): any {
  const output: any = { id: encodeId('PullRequest', pull.id), number: pull.number, title: pull.title,
    state: pull.state === 'open' ? 'OPEN' : 'CLOSED', merged: pull.state === 'closed', headRefName: pull.head,
    baseRefName: pull.base, mergeable: pull.mergeable ? 'MERGEABLE' : 'CONFLICTING' };
  if (query.includes('files(')) output.files = { nodes: pull.files.map((file: any) => ({ path: file.filename })) };
  return output;
}

function introspection(query: string, data: any): void {
  const expression = /(\w+)\s*:\s*__type\(name:\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(query))) {
    const alias = match[1]!, type = match[2]!;
    data[alias] = { name: type, fields: (fields[type] || ['id', 'number', 'title', 'state', 'body']).map((name) => ({ name })),
      ...(type === 'SearchType' ? { enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'].map((name) => ({ name })) } : {}) };
  }
}

export function executeGraphql(query: string, variables: any = {}, login = viewer): any {
  const data: any = {};
  if (query.includes('viewer')) data.viewer = { login };
  const owner = variables.owner || query.match(/owner:\s*"([^"]+)"/)?.[1] || login;
  const name = variables.name || query.match(/name:\s*"([^"]+)"/)?.[1] || '';
  const repo = getRepo(owner, name);
  if (query.includes('repository(')) {
    if (!repo) { data.repository = null; return { data }; }
    const output: any = { id: encodeId('Repository', repo.id), databaseId: repo.id, name: repo.name,
      nameWithOwner: repo.owner + '/' + repo.name, owner: { login: repo.owner }, defaultBranchRef: { name: 'main' },
      viewerPermission: 'ADMIN', hasIssuesEnabled: true };
    if (query.includes('issues(')) {
      let issues = repo.issues.filter((issue) => !query.includes('CLOSED') ? issue.state === 'open' : true);
      if (query.includes('direction: DESC')) issues = issues.slice().reverse();
      const first = variables.first || 10, after = variables.after ? +(String(variables.after).split(':').pop() || 0) : 0;
      output.issues = { nodes: issues.slice(after, after + first).map((issue: any) => issueNode(repo, issue)),
        pageInfo: { hasNextPage: after + first < issues.length, endCursor: String(Math.min(after + first, issues.length)) } };
    }
    if (query.includes('issue(number:')) {
      const number = variables.number || +(query.match(/number:\s*(\d+)/)?.[1] || 0);
      const issue = repo.issues.find((entry) => entry.number === number); output.issue = issue ? issueNode(repo, issue) : null;
    }
    if (query.includes('pullRequests(')) output.pullRequests = { nodes: repo.pulls.slice(0, variables.first || 5).map((pull) => pullNode(pull, query)) };
    if (query.includes('pullRequest(number:')) {
      const number = variables.number || +(query.match(/number:\s*(\d+)/)?.[1] || 0);
      const pull = repo.pulls.find((entry) => entry.number === number); output.pullRequest = pull ? pullNode(pull, query) : null;
    }
    data.repository = output;
  }
  if (query.includes('createIssue')) {
    const target = (variables.input?.repositoryId && repositoryForId(variables.input.repositoryId)) || getRepo(login, name) || makeRepo(login, name);
    const issue = addIssue(target, variables.input || {});
    data.createIssue = { issue: { number: issue.number, id: encodeId('Issue', issue.id) } };
  }
  if (query.includes('closeIssue')) {
    const id = decodeURIComponent(variables.input?.issueId || '');
    const found = [...repositories.values()].flatMap((entry) => entry.issues).find((issue) => encodeId('Issue', issue.id) === id);
    if (found) found.state = 'closed';
    data.closeIssue = { issue: found ? { number: found.number, id: variables.input.issueId, state: 'CLOSED' } : null };
  }
  if (query.includes('createPullRequest')) {
    const target = (variables.input?.repositoryId && repositoryForId(variables.input.repositoryId)) || getRepo(login, name) || makeRepo(login, name);
    const input = variables.input || {};
    const pull: any = { id: allocateId(), number: target.pulls.length + 1, title: input.title || '', body: '', state: 'open',
      head: input.headRefName, base: input.baseRefName, headsha: target.branches.get(input.headRefName) || '',
      basesha: target.branches.get(input.baseRefName) || '', mergeable: true, merge_commit_sha: null, files: [] };
    target.pulls.push(pull); data.createPullRequest = { pullRequest: pullNode(pull, query) };
  }
  if (query.includes('mergePullRequest')) {
    const input = variables.input || {};
    const pull = [...repositories.values()].flatMap((entry) => entry.pulls).find((item) => encodeId('PullRequest', item.id) === input.pullRequestId);
    if (pull) { pull.state = 'closed'; pull.merge_commit_sha = ''; }
    data.mergePullRequest = { pullRequest: pull ? { number: pull.number, merged: true, state: 'MERGED' } : null };
  }
  if (query.includes('addComment')) {
    const input = variables.input || {}, comment = { id: encodeId('IssueComment', allocateId()), body: input.body || '' };
    data.addComment = { commentEdge: { node: comment } };
    const issue = [...repositories.values()].flatMap((entry) => entry.issues).find((item) => encodeId('Issue', item.id) === input.subjectId);
    if (issue) {
      const parent = [...repositories.values()].find((entry) => entry.issues.includes(issue))!;
      const comments = parent.comments.get(issue.number) || [];
      comments.push({ id: allocateId(), body: comment.body, user: { login }, created_at: now }); parent.comments.set(issue.number, comments);
    }
  }
  if (query.includes('__type')) introspection(query, data);
  if (query.includes('node(id:')) {
    const id = variables.id, found = [...repositories.values()].find((entry) => encodeId('Repository', entry.id) === id);
    data.node = found ? { id, name: found.name, nameWithOwner: found.owner + '/' + found.name } : null;
  }
  if (query.includes('noSuchField')) return { data: { viewer: { login } }, errors: [{ message: 'Cannot query field noSuchFieldOnViewer' }] };
  return { data };
}

export function handleGraphqlBody(body: any): any {
  if (Array.isArray(body)) return body.map((operation) => operation && typeof operation === 'object'
    ? executeGraphql(String(operation.query ?? ''), operation.variables ?? {})
    : { data: null, errors: [{ message: 'Invalid operation' }] });
  return executeGraphql(String(body?.query ?? ''), body?.variables ?? {});
}
