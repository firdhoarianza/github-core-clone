/**
 * The forge's deterministic scenario data. Each named stream isolates a fixture family, so adding
 * a draw to one generator cannot reshuffle any other part. The fixed seed and epoch preserve the
 * serialized scenario contract used by the entry and the grader.
 */
export {};

const FIXTURE_SEED = 0x6a09e667f3bcc909n;
const FIXTURE_SEED_HEX = '6a09e667f3bcc909';
const UINT64_MASK = 0xffffffffffffffffn;
const FIXTURE_EPOCH_SECONDS = 1_735_689_600;
const DEFAULT_BRANCH = 'main';

interface ScenarioUser { readonly id: number; readonly login: string; readonly name: string; readonly email: string }
interface ScenarioRepo {
  readonly id: number; readonly owner: string; readonly name: string; readonly fullName: string;
  readonly description: string; readonly private: boolean; readonly defaultBranch: string;
}
interface ScenarioBlob { readonly path: string; readonly content: string; readonly base64: string }
interface ScenarioCommit { readonly message: string; readonly author: ScenarioUser; readonly epochSec: number; readonly iso: string }
interface ScenarioIssue { readonly title: string; readonly body: string; readonly labels: readonly string[] }
interface ScenarioPull { readonly title: string; readonly body: string; readonly head: string; readonly base: string }
interface ForgeScenario {
  readonly seed: string; readonly viewer: ScenarioUser; readonly teammate: ScenarioUser; readonly stranger: ScenarioUser;
  readonly users: readonly ScenarioUser[]; readonly org: string; readonly repos: readonly ScenarioRepo[];
  readonly orgRepos: readonly ScenarioRepo[]; readonly strangerRepos: readonly ScenarioRepo[];
  readonly labels: readonly string[]; readonly branches: readonly string[]; readonly filePaths: readonly string[];
  readonly blobs: readonly ScenarioBlob[]; readonly commits: readonly ScenarioCommit[];
  readonly issues: readonly ScenarioIssue[]; readonly pulls: readonly ScenarioPull[];
}

/** Independent xorshift64* stream. All arithmetic is masked to unsigned 64-bit state. */
class ScenarioRng {
  #state: bigint;

  constructor(seed: bigint) {
    const state = seed & UINT64_MASK;
    this.#state = state === 0n ? FIXTURE_SEED : state;
  }

  next32(): number {
    let value = this.#state;
    value = (value ^ (value >> 12n)) & UINT64_MASK;
    value = (value ^ (value << 25n)) & UINT64_MASK;
    value = (value ^ (value >> 27n)) & UINT64_MASK;
    this.#state = value;
    return Number(((value * 0x2545f4914f6cdd1dn) & UINT64_MASK) >> 32n);
  }

  int(limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4_294_967_296) {
      throw new RangeError('scenario random limit must be an integer from 1 through 2^32');
    }
    const range = 4_294_967_296;
    const ceiling = range - range % limit;
    let value: number;
    do value = this.next32(); while (value >= ceiling);
    return value % limit;
  }

  chance(probability: number): boolean { return this.next32() / 4_294_967_296 < probability; }
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('cannot pick from an empty scenario list');
    return items[this.int(items.length)] as T;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const result = items.slice();
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      [result[i], result[j]] = [result[j] as T, result[i] as T];
    }
    return result;
  }
}

function hashLabel(label: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < label.length; i += 1) {
    hash = ((hash ^ BigInt(label.charCodeAt(i))) * 0x100000001b3n) & UINT64_MASK;
  }
  return hash;
}

function mixSeed(seed: bigint): bigint {
  let value = (seed + 0x9e3779b97f4a7c15n) & UINT64_MASK;
  value = ((value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n) & UINT64_MASK;
  value = ((value ^ (value >> 27n)) * 0x94d049bb133111ebn) & UINT64_MASK;
  return (value ^ (value >> 31n)) & UINT64_MASK;
}

function scenarioStream(label: string): ScenarioRng {
  return new ScenarioRng(mixSeed(FIXTURE_SEED ^ hashLabel(label)));
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];
const REPO_ADJECTIVES = [
  'amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively',
  'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat',
  'vivid', 'warm', 'witty', 'young', 'zesty',
];
const REPO_NOUNS = [
  'acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor',
  'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven',
  'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr',
];
const REPO_DESCRIPTIONS = [
  'a small service with a sharp edge', 'notes and experiments, kept until they are not',
  'the tooling behind the thing', 'a reference implementation, for reading', 'what the prototype became',
  'fixtures, generators and the odd benchmark', 'the parts that must not break', 'a sandbox for the next idea',
];
const PATH_SEGMENTS = [
  'src', 'lib', 'docs', 'test', 'scripts', 'api', 'core', 'util', 'config', 'data', 'web', 'cli', 'pkg',
  'internal', 'examples', 'assets', 'build', 'tools', 'server', 'client',
];
const FILE_STEMS = [
  'index', 'request', 'response', 'server', 'client', 'schema', 'parser', 'router', 'config', 'store',
  'clock', 'queue', 'render', 'format', 'validate', 'session', 'token', 'event', 'stream', 'cache',
];
const FILE_EXTENSIONS = ['ts', 'js', 'json', 'md', 'txt', 'yml', 'toml', 'css', 'html', 'sql'];
const BLOB_WORDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo',
  'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor',
  'whiskey', 'xray', 'yankee', 'zulu', 'amber', 'basalt', 'cobalt', 'drift', 'ember', 'frost', 'granite',
  'hollow', 'ivory', 'jasper', 'kelp', 'lichen', 'moss', 'nickel',
];
const COMMIT_VERBS = [
  'Add', 'Fix', 'Refactor', 'Document', 'Test', 'Tidy', 'Speed up', 'Simplify', 'Handle', 'Extract',
  'Inline', 'Rename', 'Guard', 'Wire', 'Drop',
];
const COMMIT_OBJECTS = [
  'the request parser', 'repo lookup', 'issue pagination', 'the merge path', 'token checks',
  'the clone endpoint', 'packfile handling', 'error bodies', 'branch listing', 'the GraphQL node query',
  'MCP tool dispatch', 'rate limit headers', 'the upload pack', 'the ref advertisement', 'commit ancestry',
];
const ISSUE_ADJECTIVES = ['Broken', 'Slow', 'Missing', 'Confusing', 'Unexpected', 'Flaky', 'Incorrect', 'Unclear', 'Stale', 'Noisy'];
const ISSUE_SUBJECTS = [
  'clone over HTTP', 'push report-status', 'issue pagination', 'merge button', 'GraphQL node ids',
  'MCP tool list', 'shallow fetch', 'tag listing', 'repo creation', 'content update', 'branch deletion',
  'commit listing',
];
const PULL_VERBS = ['Add', 'Fix', 'Improve', 'Simplify', 'Document', 'Refactor', 'Speed up', 'Harden'];
const PULL_SUBJECTS = [
  'shallow fetch support', 'push report status checks', 'issue label validation', 'merge conflict detection',
  'GraphQL cursor pagination', 'MCP tool schemas', 'packfile delta reuse', 'conditional requests',
  'repo pagination', 'branch protection stubs',
];
const SENTENCE_STARTS = [
  'Steps to reproduce are below', 'This showed up after the last change', 'The expected behaviour is clear',
  'A minimal case is attached', 'It works on a fresh repository', 'The same flow works over the API',
];
const SENTENCE_ENDS = [
  'and the server answers with a JSON error', 'but the second request fails', 'and nothing is written to the log',
  'while the reply body stays empty', 'and the status is wrong for the method', 'so the client gives up',
];
const ISSUE_LABELS = ['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted'];
const STANDARD_BRANCHES = ['main', 'develop', 'release/1.0'];

function createUsers(random: ScenarioRng, count: number): ScenarioUser[] {
  const seen = new Set<string>();
  return Array.from({ length: count }, (_, id) => {
    const first = random.pick(FIRST_NAMES);
    const last = random.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base, suffix = 2;
    while (seen.has(login)) login = `${base}-${suffix++}`;
    seen.add(login);
    return Object.freeze({ id: 1000 + id, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  });
}

function createRepos(random: ScenarioRng, owner: string, count: number, firstId: number): ScenarioRepo[] {
  const seen = new Set<string>();
  return Array.from({ length: count }, (_, index) => {
    const base = `${random.pick(REPO_ADJECTIVES)}-${random.pick(REPO_NOUNS)}`;
    let name = base, suffix = 2;
    while (seen.has(name)) name = `${base}-${suffix++}`;
    seen.add(name);
    return Object.freeze({
      id: firstId + index, owner, name, fullName: `${owner}/${name}`,
      description: random.pick(REPO_DESCRIPTIONS), private: index % 7 === 3, defaultBranch: DEFAULT_BRANCH,
    });
  });
}

function createPaths(random: ScenarioRng, count: number): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  while (paths.length < count) {
    const depth = random.int(3) === 0 ? 0 : 1 + random.int(2);
    const directories = depth === 0 ? [] : random.shuffle(PATH_SEGMENTS).slice(0, depth);
    const filename = `${random.pick(FILE_STEMS)}.${random.pick(FILE_EXTENSIONS)}`;
    const base = [...directories, filename].join('/');
    let path = base, suffix = 2;
    while (seen.has(path)) path = [...directories, `${suffix++}-${filename}`].join('/');
    seen.add(path); paths.push(path);
  }
  return paths;
}

function textAsBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let encoded = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0, b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0;
    const word = (a << 16) | (b << 8) | c;
    encoded += alphabet[(word >> 18) & 63] + alphabet[(word >> 12) & 63];
    encoded += i + 1 < bytes.length ? alphabet[(word >> 6) & 63] : '=';
    encoded += i + 2 < bytes.length ? alphabet[word & 63] : '=';
  }
  return encoded;
}

function createBlob(random: ScenarioRng, path: string, size: number): ScenarioBlob {
  let content = '';
  while (content.length < size) {
    content += random.pick(BLOB_WORDS);
    if (content.length < size) content += random.chance(0.14) ? '\n' : ' ';
  }
  content = content.slice(0, size);
  return Object.freeze({ path, content, base64: textAsBase64(content) });
}

function sentence(random: ScenarioRng): string {
  return `${random.pick(SENTENCE_STARTS)} ${random.pick(SENTENCE_ENDS)}.`;
}

function body(random: ScenarioRng): string {
  const lines = Array.from({ length: 1 + random.int(3) }, () => sentence(random));
  return lines.join(' ');
}

function branchName(random: ScenarioRng): string {
  const kind = random.pick(['feature', 'fix', 'perf', 'docs', 'chore']);
  const subject = random.pick(PULL_SUBJECTS).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${kind}/${subject}`;
}

function freezeScenario<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) freezeScenario(item);
    Object.freeze(value);
  }
  return value;
}

function createCommits(users: readonly ScenarioUser[]): ScenarioCommit[] {
  const random = scenarioStream('commits');
  return Array.from({ length: 60 }, () => {
    const author = random.pick(users);
    const epochSec = FIXTURE_EPOCH_SECONDS + random.int(90 * 24 * 60 * 60);
    const head = `${random.pick(COMMIT_VERBS)} ${random.pick(COMMIT_OBJECTS)}`;
    const message = random.chance(0.35) ? `${head}\n\n${sentence(random)}` : head;
    return Object.freeze({ message, author, epochSec, iso: new Date(epochSec * 1000).toISOString() });
  });
}

function createIssues(): ScenarioIssue[] {
  const random = scenarioStream('issues');
  return Array.from({ length: 60 }, () => Object.freeze({
    title: `${random.pick(ISSUE_ADJECTIVES)} ${random.pick(ISSUE_SUBJECTS)}`,
    body: body(random), labels: random.chance(0.5) ? [random.pick(ISSUE_LABELS)] : [],
  }));
}

function createPulls(): ScenarioPull[] {
  const random = scenarioStream('pulls');
  return Array.from({ length: 30 }, () => Object.freeze({
    title: `${random.pick(PULL_VERBS)} ${random.pick(PULL_SUBJECTS)}`,
    body: body(random), head: branchName(random), base: DEFAULT_BRANCH,
  }));
}

let cachedScenario: ForgeScenario | undefined;

/** Build the one immutable scenario consumed by the forge and its local conformance checks. */
export function buildScenario(): ForgeScenario {
  if (cachedScenario !== undefined) return cachedScenario;
  const users = createUsers(scenarioStream('users'), 12);
  const viewer = users[0] as ScenarioUser;
  const teammate = users[1] as ScenarioUser;
  const stranger = users[2] as ScenarioUser;

  const orgRandom = scenarioStream('org');
  const org = `${orgRandom.pick(REPO_ADJECTIVES)}-${orgRandom.pick(REPO_NOUNS)}-org`;
  const branches = new Set(STANDARD_BRANCHES);
  const branchRandom = scenarioStream('branches');
  for (let i = 0; i < 8; i += 1) {
    let branch = branchName(branchRandom), suffix = 2;
    while (branches.has(branch)) branch = `${branchName(branchRandom)}-${suffix++}`;
    branches.add(branch);
  }

  const filePaths = createPaths(scenarioStream('paths'), 60);
  const blobRandom = scenarioStream('blobs');
  const blobs = filePaths.slice(0, 24).map((path) => createBlob(blobRandom, path, 64 + blobRandom.int(4_033)));
  const commits = createCommits(users);
  const issues = createIssues();
  const pulls = createPulls();

  cachedScenario = freezeScenario({
    seed: FIXTURE_SEED_HEX, viewer, teammate, stranger, users, org,
    repos: createRepos(scenarioStream('repos.viewer'), viewer.login, 30, 5000),
    orgRepos: createRepos(scenarioStream('repos.org'), org, 6, 6000),
    strangerRepos: createRepos(scenarioStream('repos.stranger'), stranger.login, 3, 7000),
    labels: ISSUE_LABELS, branches: [...branches], filePaths, blobs, commits, issues, pulls,
  });
  return cachedScenario;
}
