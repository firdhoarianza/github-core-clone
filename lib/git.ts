import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

type ObjectValue = { type: string; data: Buffer };
type Repository = { refs: Map<string, string>; branches: Map<string, string>; objects: Map<string, ObjectValue> };
type Packet = { data: Buffer } | { flush: true } | { delim: true } | { end: true };

function pkt(value: string | Buffer): Buffer {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = data.length + 4;
  // Git limits ordinary packet records to 65,520 bytes total; sideband chunks use this ceiling.
  if (length > 65520) throw new RangeError('pkt-line exceeds the protocol length limit');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0')), data]);
}
const flush = () => Buffer.from('0000');
export const gitObjectHash = (type: string, data: Buffer) => createHash('sha1').update(Buffer.concat([Buffer.from(type + ' ' + data.length + '\0'), data])).digest('hex');

export function parsePktLines(input: Buffer): { packets: Packet[]; offset: number } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= input.length) {
    const header = input.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    offset += 4;
    if (length === 0) { packets.push({ flush: true }); continue; }
    if (length === 1) { packets.push({ delim: true }); continue; }
    if (length === 2) { packets.push({ end: true }); continue; }
    if (length < 4 || offset + length - 4 > input.length) { offset -= 4; break; }
    packets.push({ data: input.subarray(offset, offset + length - 4) });
    offset += length - 4;
  }
  return { packets, offset };
}

export function commitParents(object?: ObjectValue): string[] {
  return object?.type === 'commit' ? [...object.data.toString().matchAll(/^parent ([a-f0-9]{40})/gm)].map((match) => match[1]!) : [];
}
export function commitTree(repo: Repository, commit: string): string { return repo.objects.get(commit)?.data.toString().match(/^tree ([a-f0-9]{40})/m)?.[1] || ''; }
const objectHash = gitObjectHash;
const parents = commitParents;
const treeOf = commitTree;

function readPack(pack: Buffer): Map<string, ObjectValue> {
  const result = new Map<string, ObjectValue>();
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') return result;
  let cursor = 12;
  for (let i = 0; i < pack.readUInt32BE(8) && cursor < pack.length - 20; i += 1) {
    let byte = pack[cursor++]!; const kind = (byte >> 4) & 7;
    let size = byte & 15, shift = 4;
    while (byte & 128) { if (cursor >= pack.length) return result; byte = pack[cursor++]!; size |= (byte & 127) << shift; shift += 7; }
    if (kind === 6) while (cursor < pack.length && (pack[cursor++]! & 128)) { /* delta base offset */ }
    if (kind === 7) cursor += 20;
    if (cursor > pack.length) return result;
    const inflated = inflateSync(pack.subarray(cursor), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    cursor += inflated.engine.bytesWritten;
    const type = ({ 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' } as Record<number, string>)[kind];
    if (type) { const data = inflated.buffer.subarray(0, size); result.set(objectHash(type, data), { type, data }); }
  }
  return result;
}

function writePack(objects: ObjectValue[]): Buffer {
  const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(objects.length, 8);
  const chunks: Buffer[] = [header];
  for (const object of objects) {
    const type = ({ commit: 1, tree: 2, blob: 3, tag: 4 } as Record<string, number>)[object.type];
    let size = object.data.length; const encoded = [(type << 4) | (size & 15)]; size >>= 4;
    while (size) { encoded[encoded.length - 1]! |= 128; encoded.push(size & 127); size >>= 7; }
    chunks.push(Buffer.from(encoded), deflateSync(object.data));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export function gitRefs(repo: Repository, service: string, v2: boolean): Buffer {
  if (service === 'git-receive-pack') {
    const caps = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=git/2.43.0';
    const first = [...repo.refs].find(([name]) => name.startsWith('refs/'));
    const line = first ? first[1] + ' ' + first[0] + '\0' + caps + '\n' : '0'.repeat(40) + ' capabilities^{}\0' + caps + '\n';
    return Buffer.concat([pkt('# service=git-receive-pack\n'), flush(), pkt(line), flush()]);
  }
  if (v2) return Buffer.concat([pkt('version 2\n'), pkt('agent=git/2.43.0\n'), pkt('ls-refs=unborn\n'), pkt('fetch=shallow wait-for-done\n'), pkt('object-format=sha1\n'), flush()]);
  const caps = 'multi_ack_detailed side-band-64k ofs-delta shallow no-progress agent=git/2.43.0 symref=HEAD:refs/heads/main object-format=sha1';
  const refs = [...repo.refs].filter(([name]) => name.startsWith('refs/'));
  const lines = refs.length ? refs.map(([name, sha], i) => pkt(sha + ' ' + name + (i === 0 ? '\0' + caps : '') + '\n')) : [pkt('0'.repeat(40) + ' capabilities^{}\0' + caps + '\n')];
  return Buffer.concat([pkt('# service=git-upload-pack\n'), ...lines, flush()]);
}

function lsRefs(repo: Repository, lines: string[]): Buffer {
  const prefixes: string[] = []; let peel = false, symrefs = false;
  for (const line of lines.map((item) => item.trim())) {
    if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
    else if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
  }
  const included = (name: string) => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const output: Buffer[] = [], head = repo.branches.get('main') || repo.refs.get('refs/heads/main') || '';
  if (head && included('HEAD')) output.push(pkt(head + ' HEAD' + (symrefs ? ' symref-target:refs/heads/main' : '') + '\n'));
  for (const [name, sha] of [...repo.refs].filter(([ref]) => ref.startsWith('refs/')).sort()) {
    if (!included(name)) continue;
    const object = repo.objects.get(sha);
    const target = peel && name.startsWith('refs/tags/') && object?.type === 'tag' ? object.data.toString().match(/^object ([a-f0-9]{40})/m)?.[1] : undefined;
    output.push(pkt(sha + ' ' + name + (target ? ' peeled:' + target : '') + '\n'));
  }
  return Buffer.concat([...output, flush()]);
}

function reachable(repo: Repository, tip: string, depth = 0, skip = new Set<string>(), shallow = new Set<string>(), stopAtBoundary = false): ObjectValue[] {
  const output: ObjectValue[] = [], visited = new Set<string>(), pending: Array<[string, number]> = [[tip, 0]];
  while (pending.length) {
    const [sha, level] = pending.pop()!; if (visited.has(sha)) continue; visited.add(sha);
    const object = repo.objects.get(sha); if (!object) continue;
    if (!skip.has(sha)) output.push(object);
    if (object.type === 'commit') {
      const tree = treeOf(repo, sha); if (tree) pending.push([tree, level]);
      if (!stopAtBoundary || !shallow.has(sha)) if (!depth || level < depth - 1) for (const parent of parents(object)) if (!shallow.has(parent)) pending.push([parent, level + 1]);
    } else if (object.type === 'tag') {
      const target = object.data.toString().match(/^object ([a-f0-9]{40})/m)?.[1]; if (target) pending.push([target, level]);
    } else if (object.type === 'tree') {
      let offset = 0;
      while (offset < object.data.length) {
        const space = object.data.indexOf(32, offset), zero = object.data.indexOf(0, space);
        if (space < 0 || zero < 0 || zero + 21 > object.data.length) break;
        pending.push([object.data.subarray(zero + 1, zero + 21).toString('hex'), level]); offset = zero + 21;
      }
    }
  }
  return output;
}

function fetchPack(repo: Repository, body: Buffer, v2: boolean): Buffer {
  const lines = parsePktLines(body).packets.filter((item): item is { data: Buffer } => 'data' in item).map((item) => item.data.toString());
  const wants = lines.map((line) => line.match(/want ([a-f0-9]{40})/)?.[1]).filter((sha): sha is string => !!sha);
  if (!wants.length) return Buffer.alloc(0);
  const depth = Number(lines.map((line) => line.match(/deepen (\d+)/)?.[1]).find(Boolean) || 0);
  const haves = lines.map((line) => line.match(/^have ([a-f0-9]{40})/)?.[1]).filter((sha): sha is string => !!sha);
  const boundaryList = lines.map((line) => line.match(/^shallow ([a-f0-9]{40})/)?.[1]).filter((sha): sha is string => !!sha);
  const shallow = new Set(boundaryList), common = new Set<string>();
  for (const have of haves) for (const object of reachable(repo, have, 0, new Set(), shallow, true)) common.add(objectHash(object.type, object.data));
  const objects: ObjectValue[] = [], seen = new Set<string>();
  for (const want of wants) for (const object of reachable(repo, want, depth, common)) {
    const sha = objectHash(object.type, object.data); if (!seen.has(sha)) { seen.add(sha); objects.push(object); }
  }
  const pack = writePack(objects), output: Buffer[] = [];
  if (v2) {
    output.push(pkt('acknowledgments\n'), pkt(haves.length ? 'ACK ' + haves[0] + '\n' : 'NAK\n'), flush());
    const info: Buffer[] = [pkt('shallow-info\n')];
    if (depth) {
      const additions: string[] = [];
      for (const want of wants) { let commit = want, level = 0; while (commit && level < depth - 1) { commit = parents(repo.objects.get(commit))[0] || ''; level += 1; } if (commit && !shallow.has(commit)) additions.push(commit); }
      for (const sha of shallow) info.push(pkt('unshallow ' + sha + '\n'));
      for (const sha of additions) info.push(pkt('shallow ' + sha + '\n'));
    }
    if (info.length > 1) output.push(...info, flush());
    output.push(pkt('packfile\n'));
  }
  for (let i = 0; i < pack.length; i += 65515) output.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(i, Math.min(i + 65515, pack.length))])));
  output.push(flush()); return Buffer.concat(output);
}

function uploadV2(repo: Repository, body: Buffer): Buffer {
  const lines = parsePktLines(body).packets.filter((item): item is { data: Buffer } => 'data' in item).map((item) => item.data.toString());
  const command = lines.map((line) => line.match(/command=(\S+)/)?.[1]).find(Boolean);
  return command === 'ls-refs' ? lsRefs(repo, lines) : fetchPack(repo, body, true);
}
function isAncestor(repo: Repository, oldSha: string, newSha: string): boolean {
  if (oldSha === '0'.repeat(40)) return true;
  const pending = [newSha], seen = new Set<string>();
  while (pending.length) { const sha = pending.pop()!; if (sha === oldSha) return true; if (seen.has(sha)) continue; seen.add(sha); pending.push(...parents(repo.objects.get(sha))); }
  return false;
}
function receivePack(repo: Repository, body: Buffer): Buffer {
  let offset = 0; const commands: string[][] = [];
  while (offset + 4 <= body.length) {
    const header = body.toString('ascii', offset, offset + 4); if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16); offset += 4; if (!length) break;
    if (length < 4 || offset + length - 4 > body.length) { offset -= 4; break; }
    const line = body.subarray(offset, offset + length - 4).toString().split('\0')[0]!.trim(); if (line) commands.push(line.split(' ')); offset += length - 4;
  }
  let incoming: Map<string, ObjectValue>;
  try {
    incoming = body.length - offset > 20 ? readPack(body.subarray(offset)) : new Map<string, ObjectValue>();
  } catch {
    const status = Buffer.concat([pkt('unpack error\n'), flush()]);
    return Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), status])), flush()]);
  }
  for (const [sha, object] of incoming) repo.objects.set(sha, object);
  const report = ['unpack ok'];
  for (const [oldSha, newSha, ref] of commands) {
    const current = repo.refs.get(ref!) || '0'.repeat(40);
    if (current !== oldSha) { report.push('ng ' + ref + ' old oid mismatch'); continue; }
    if (newSha === '0'.repeat(40)) { repo.refs.delete(ref!); if (ref!.startsWith('refs/heads/')) repo.branches.delete(ref!.slice(11)); report.push('ok ' + ref); continue; }
    if (!isAncestor(repo, oldSha!, newSha!)) { report.push('ng ' + ref + ' non-fast-forward'); continue; }
    if (!repo.objects.has(newSha!)) { report.push('ng ' + ref + ' missing object'); continue; }
    repo.refs.set(ref!, newSha!); if (ref!.startsWith('refs/heads/')) repo.branches.set(ref!.slice(11), newSha!); report.push('ok ' + ref);
  }
  const status = Buffer.concat([...report.map((line) => pkt(line + '\n')), flush()]);
  return Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), status])), flush()]);
}

export const gitFetch = fetchPack;
export const gitUploadV2 = uploadV2;
export const gitPush = receivePack;
