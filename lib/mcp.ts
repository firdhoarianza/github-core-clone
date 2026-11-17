import {
  addIssue, allocateId, createPull, getRepo, makeCommit, makeRepo, pullJson, issueJson, repositoryJson,
  type Repository,
} from './store.ts';
import { buildTree, listFiles } from './store.ts';
import { commitTree } from './git.ts';

const tools = [
  { name: 'create_repo', description: 'Create a repository', inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } }, required: ['owner', 'repo', 'pull_number'] } },
];
const reply = (id: unknown, result: any) => ({ jsonrpc: '2.0', id, result });
const failure = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
const content = (value: any) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const toolError = (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] });

function invokeTool(name: string, args: any, login: string): any {
  const owner = args.owner || login, nameOfRepo = args.repo || '', repo = getRepo(owner, nameOfRepo);
  if (name === 'create_repo') return content(repositoryJson(getRepo(login, args.name) || makeRepo(login, args.name, args)));
  if (name === 'get_repo') return repo ? content(repositoryJson(repo)) : toolError('Not Found');
  if (name === 'create_issue') return repo && args.title ? content(issueJson(repo, addIssue(repo, args))) : toolError('Invalid arguments');
  if (name === 'list_issues') return repo
    ? content(repo.issues.filter((issue) => !args.state || args.state === 'all' || issue.state === args.state).map((issue) => issueJson(repo, issue)))
    : toolError('Not Found');
  if (name === 'create_pull_request') {
    if (!repo) return toolError('Not Found');
    return content(pullJson(repo, createPull(repo, { ...args, body: '' })));
  }
  if (name === 'merge_pull_request') {
    const pull = repo?.pulls.find((item) => item.number === +args.pull_number);
    if (!repo || !pull) return toolError('Not Found');
    const tree = commitTree(repo, pull.headsha) || commitTree(repo, pull.basesha);
    const sha = makeCommit(repo, pull.title + ' (#' + pull.number + ')', tree, pull.basesha);
    pull.state = 'closed'; pull.merge_commit_sha = sha;
    return content(pullJson(repo, pull));
  }
  return null;
}

export function executeMcp(request: any, login: string): any | null {
  const id = request?.id ?? null, method = request?.method, params = request?.params || {};
  if (!request || request.jsonrpc !== '2.0' || typeof method !== 'string') return failure(id, -32600, 'Invalid Request');
  if (method === 'initialize') return reply(id, { protocolVersion: params.protocolVersion || '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'github-forge', version: '1.0.0' } });
  if (method === 'notifications/initialized') return null;
  if (method === 'server/discover') return reply(id, { supportedVersions: ['2026-07-28', '2025-11-25'], serverInfo: { name: 'github-forge', version: '1.0.0' }, capabilities: { tools: {} } });
  if (method === 'tools/list') return reply(id, { tools });
  if (method !== 'tools/call') return failure(id, -32601, 'Method not found');
  const name = params.name, definition = tools.find((tool) => tool.name === name);
  if (!definition) return failure(id, -32602, 'Unknown tool');
  return reply(id, invokeTool(name, params.arguments || {}, login));
}

export function handleMcpBody(body: any, login: string): any {
  if (Array.isArray(body)) return body.map((entry) => executeMcp(entry, login) || null);
  return executeMcp(body, login);
}
