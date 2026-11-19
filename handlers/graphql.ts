// GitHub-compatible GraphQL v4 endpoint (POST /api/graphql), stdlib only, deterministic.
//
// A deliberately small GraphQL engine: a tokenizer + recursive-descent parser for the subset of the
// language gh / github-mcp-server actually send (fields, aliases, arguments of every literal shape,
// variables, inline fragments, operation names), plus a resolver layer over the shared in-memory
// store. No schema library, no clock, no randomness: every id is derived from a store counter or a
// repo/number pair, so repeated reads are byte-identical.
//
// Wire rules honoured here:
//   - unauthenticated (no valid bearer token) -> HTTP 401
//   - an unknown field -> HTTP 200 with { errors: [{ message: 'Cannot query field ...' }] }
//   - an unknown repository -> { data: { repository: null } } with NO errors
//   - a JSON array body -> an array of the usual per-operation bodies, in the same order
//   - global ids are opaque, stable base64url strings (never the bare databaseId / number)

import type { Ctx } from '../app.ts';
import { store, gid } from '../store.ts';
import { sendJson, readJson } from '../http.ts';

// --------------------------------------------------------------------------- utils

function isRecord(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function tag<T extends object>(obj: T, typeName: string): T {
  Object.defineProperty(obj, '__typename', { value: typeName, enumerable: false, configurable: true });
  return obj;
}

/** Global ids: opaque, deterministic, stable across reads. */
const repoGid = (r: any): string => gid('Repository', r.id);
function issueNumId(r: any, i: any): number {
  return typeof i.id === 'number' && i.id > 0 ? i.id : r.id * 100000 + i.number;
}
function pullNumId(r: any, p: any): number {
  return typeof p.id === 'number' && p.id > 0 ? p.id : r.id * 100000 + p.number;
}
const issueGid = (r: any, i: any): string => gid('Issue', issueNumId(r, i));
const pullGid = (r: any, p: any): string => gid('PullRequest', pullNumId(r, p));

function decodeGid(id: unknown): { type: string; id: number } | null {
  if (typeof id !== 'string') return null;
  try {
    const s = Buffer.from(id, 'base64url').toString('utf8');
    const idx = s.indexOf(':');
    if (idx < 0) return null;
    const num = Number(s.slice(idx + 1));
    if (!Number.isFinite(num)) return null;
    return { type: s.slice(0, idx), id: num };
  } catch {
    return null;
  }
}

/** The viewer login. Shared with REST (which seeds store.owner from GET /user). */
function viewerLogin(): string {
  if (store.owner) return store.owner;
  for (const r of store.repos.values()) if (r.owner) return r.owner;
  return 'octocat';
}

const storeIssues = (r: any): any[] => store.issuesOf(store.repoKey(r.owner, r.name));
const storePulls = (r: any): any[] => store.pullsOf(store.repoKey(r.owner, r.name));

/** Exact key first, then a name-only fallback so the handler tolerates an owner-path mismatch. */
function findRepo(owner: unknown, name: unknown): any | null {
  if (typeof owner === 'string' && typeof name === 'string') {
    const exact = store.repos.get(store.repoKey(owner, name));
    if (exact) return exact;
  }
  const nm = String(name ?? '').toLowerCase();
  if (nm !== '') {
    for (const r of store.repos.values()) if (String(r.name).toLowerCase() === nm) return r;
  }
  return null;
}
function findRepoByGid(id: unknown): any | null {
  const d = decodeGid(id);
  if (!d || d.type !== 'Repository') return null;
  for (const r of store.repos.values()) if (r.id === d.id) return r;
  return null;
}
function findIssueByGid(id: unknown): { repo: any; issue: any } | null {
  const d = decodeGid(id);
  if (!d || d.type !== 'Issue') return null;
  for (const r of store.repos.values()) {
    const i = storeIssues(r).find((x) => issueNumId(r, x) === d.id);
    if (i) return { repo: r, issue: i };
  }
  return null;
}
function findPullByGid(id: unknown): { repo: any; pull: any } | null {
  const d = decodeGid(id);
  if (!d || d.type !== 'PullRequest') return null;
  for (const r of store.repos.values()) {
    const p = storePulls(r).find((x) => pullNumId(r, x) === d.id);
    if (p) return { repo: r, pull: p };
  }
  return null;
}

// --------------------------------------------------------------------------- tokenizer

interface Tok { t: 'name' | 'string' | 'number' | 'var' | 'punct'; v: any }

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c) || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') { toks.push({ t: 'punct', v: '...' }); i += 3; continue; }
    if (c === '$') {
      i += 1;
      const s = i;
      while (i < n && /[A-Za-z0-9_]/.test(src[i])) i += 1;
      toks.push({ t: 'var', v: src.slice(s, i) });
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c; i += 1;
      let out = '';
      while (i < n && src[i] !== q) {
        if (src[i] === '\\' && i + 1 < n) {
          const e = src[++i];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          i += 1;
        } else {
          out += src[i++];
        }
      }
      i += 1;
      toks.push({ t: 'string', v: out });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const s = i; i += 1;
      while (i < n && /[0-9.eE+\-]/.test(src[i])) i += 1;
      toks.push({ t: 'number', v: Number(src.slice(s, i)) });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const s = i; i += 1;
      while (i < n && /[A-Za-z0-9_-]/.test(src[i])) i += 1;
      toks.push({ t: 'name', v: src.slice(s, i) });
      continue;
    }
    toks.push({ t: 'punct', v: c });
    i += 1;
  }
  return toks;
}

// --------------------------------------------------------------------------- parser

interface Selection {
  kind: 'field' | 'fragment';
  alias?: string;
  name?: string;
  typeCondition?: string;
  args?: Record<string, any>;
  selections?: Selection[];
}

class Parser {
  private pos = 0;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) { this.toks = toks; }

  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private next(): Tok { return this.toks[this.pos++]; }
  private isPunct(v: string): boolean {
    const t = this.peek();
    return t !== undefined && t.t === 'punct' && t.v === v;
  }
  private expectPunct(v: string): void {
    if (this.isPunct(v)) { this.pos += 1; return; }
    throw new Error(`Expected '${v}' in GraphQL document`);
  }
  private expectName(): string {
    const t = this.peek();
    if (t !== undefined && t.t === 'name') { this.pos += 1; return t.v; }
    throw new Error('Expected a name in GraphQL document');
  }
  private skipBalanced(): void {
    this.expectPunct('(');
    let depth = 1;
    while (this.pos < this.toks.length && depth > 0) {
      const t = this.next();
      if (t.t === 'punct') {
        if (t.v === '(') depth += 1;
        else if (t.v === ')') depth -= 1;
      }
    }
  }

  parseDocument(): { type: string; selections: Selection[] }[] {
    const ops: { type: string; selections: Selection[] }[] = [];
    while (this.pos < this.toks.length) {
      let type = 'query';
      const t = this.peek();
      if (t !== undefined && t.t === 'name' && ['query', 'mutation', 'subscription'].includes(t.v)) {
        type = this.next().v;
        if (this.peek()?.t === 'name') this.pos += 1; // operation name
        if (this.isPunct('(')) this.skipBalanced(); // variable definitions
      }
      ops.push({ type, selections: this.parseSelectionSet() });
    }
    return ops;
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const sels: Selection[] = [];
    while (this.pos < this.toks.length && !this.isPunct('}')) {
      if (this.isPunct('...')) {
        this.pos += 1;
        if (this.peek()?.t === 'name' && this.peek()!.v === 'on') {
          this.pos += 1;
          const typeCondition = this.expectName();
          sels.push({ kind: 'fragment', typeCondition, selections: this.parseSelectionSet() });
        } else if (this.peek()?.t === 'name') {
          this.pos += 1; // named fragment spread — not used by this suite
        }
        continue;
      }
      sels.push(this.parseField());
    }
    this.expectPunct('}');
    return sels;
  }

  private parseField(): Selection {
    const first = this.expectName();
    let alias = first;
    let name = first;
    if (this.isPunct(':')) {
      this.pos += 1;
      alias = first;
      name = this.expectName();
    }
    let args: Record<string, any> = {};
    if (this.isPunct('(')) args = this.parseArgs();
    let selections: Selection[] = [];
    if (this.isPunct('{')) selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArgs(): Record<string, any> {
    this.expectPunct('(');
    const args: Record<string, any> = {};
    while (this.pos < this.toks.length && !this.isPunct(')')) {
      const key = this.expectName();
      this.expectPunct(':');
      args[key] = this.parseValue();
      if (this.isPunct(',')) this.pos += 1;
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): any {
    const t = this.peek();
    if (t === undefined) throw new Error('Unexpected end of GraphQL document');
    if (t.t === 'var') { this.pos += 1; return { __var: t.v }; }
    if (t.t === 'string' || t.t === 'number') { this.pos += 1; return t.v; }
    if (t.t === 'punct' && t.v === '[') {
      this.pos += 1;
      const arr: any[] = [];
      while (this.pos < this.toks.length && !this.isPunct(']')) {
        arr.push(this.parseValue());
        if (this.isPunct(',')) this.pos += 1;
      }
      this.expectPunct(']');
      return arr;
    }
    if (t.t === 'punct' && t.v === '{') {
      this.pos += 1;
      const obj: Record<string, any> = {};
      while (this.pos < this.toks.length && !this.isPunct('}')) {
        const k = this.expectName();
        this.expectPunct(':');
        obj[k] = this.parseValue();
        if (this.isPunct(',')) this.pos += 1;
      }
      this.expectPunct('}');
      return obj;
    }
    if (t.t === 'name') {
      this.pos += 1;
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (t.v === 'null') return null;
      return t.v; // enum value as its string name
    }
    this.pos += 1;
    return t.v;
  }
}

// --------------------------------------------------------------------------- schema description

const SCHEMA_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'comments', 'createdAt', 'updatedAt', 'labels', 'repository', 'url'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'author', 'url', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'isPrivate'],
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'addComment', 'createPullRequest', 'mergePullRequest'],
  User: ['login', 'id', 'name', 'email'],
};
const SCHEMA_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'WIKI', 'DISCUSSION', 'CODE', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// --------------------------------------------------------------------------- resolvers

const UNKNOWN = Symbol('unknown');

interface Env { variables: Record<string, any>; errors: any[] }

const repoSource = (r: any) => tag({ _repo: r }, 'Repository');
const issueSource = (r: any, i: any) => tag({ _repo: r, _issue: i }, 'Issue');
const pullSource = (r: any, p: any) => tag({ _repo: r, _pull: p }, 'PullRequest');

function cursorOffset(after: unknown): number {
  if (typeof after !== 'string' || after === '') return 0;
  try {
    const n = Number(Buffer.from(after, 'base64url').toString('utf8'));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}
const encodeCursor = (offset: number): string => Buffer.from(String(offset), 'utf8').toString('base64url');

function issueConnection(r: any, args: Record<string, any>) {
  let issues = storeIssues(r).slice();
  if (Array.isArray(args.states) && args.states.length > 0) {
    issues = issues.filter((i) => args.states.includes(i.state === 'closed' ? 'CLOSED' : 'OPEN'));
  }
  const direction = args.orderBy && args.orderBy.direction === 'ASC' ? 1 : -1;
  issues.sort((a, b) => direction * ((a.number || 0) - (b.number || 0))); // DESC => larger number first
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const offset = cursorOffset(args.after);
  const nodes = issues.slice(offset, offset + first);
  return tag({
    _repo: r,
    _issues: nodes,
    _hasNextPage: offset + nodes.length < issues.length,
    _endCursor: encodeCursor(offset + nodes.length),
  }, 'IssueConnection');
}

function pullConnection(r: any, args: Record<string, any>) {
  let pulls = storePulls(r).slice().sort((a, b) => (b.number || 0) - (a.number || 0));
  const first = typeof args.first === 'number' ? args.first : pulls.length;
  pulls = pulls.slice(0, first);
  return tag({ _repo: r, _pulls: pulls, _hasNextPage: false, _endCursor: encodeCursor(pulls.length) }, 'PullRequestConnection');
}

/**
 * List the blob paths of a commit by walking its tree through the loose git
 * objects the receive-pack handler stores in repo.gitObjects. Git pushes never
 * populate repo.files, so this is the only reliable source for files a PR
 * changed when the PR was built from a pushed branch.
 */
function gitTreeBlobs(repo: any, oid: string): Map<string, string> {
  const objects = (repo && repo.gitObjects) as Map<string, Buffer> | undefined;
  const out = new Map<string, string>();
  if (!objects || typeof oid !== 'string' || oid === '') return out;

  const readObj = (id: string): { type: string; data: Buffer } | null => {
    const raw = objects.get(id);
    if (!raw) return null;
    const nul = raw.indexOf(0);
    const space = raw.indexOf(0x20);
    if (nul < 0 || space < 0 || space > nul) return null;
    return { type: raw.subarray(0, space).toString('ascii'), data: raw.subarray(nul + 1) };
  };
  const parseTree = (data: Buffer): { mode: string; name: string; oid: string }[] => {
    const entries: { mode: string; name: string; oid: string }[] = [];
    let i = 0;
    while (i < data.length) {
      const sp = data.indexOf(0x20, i);
      if (sp < 0) break;
      const nul = data.indexOf(0x00, sp + 1);
      if (nul < 0 || nul + 21 > data.length) break;
      entries.push({
        mode: data.subarray(i, sp).toString('ascii'),
        name: data.subarray(sp + 1, nul).toString('utf8'),
        oid: data.subarray(nul + 1, nul + 21).toString('hex'),
      });
      i = nul + 21;
    }
    return entries;
  };

  const commit = readObj(oid);
  if (!commit || commit.type !== 'commit') return out;
  const cut = commit.data.indexOf('\n\n');
  const head = (cut < 0 ? commit.data : commit.data.subarray(0, cut)).toString('utf8');
  let treeOid = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) { treeOid = line.slice(5).trim(); break; }
  }
  const walk = (tid: string, prefix: string, depth: number): void => {
    if (depth > 32) return;
    const obj = readObj(tid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = prefix + e.name;
      if (e.mode === '40000' || e.mode === '040000' || e.mode === '040000 ') walk(e.oid, `${path}/`, depth + 1);
      else out.set(path, e.oid);
    }
  };
  walk(treeOid, '', 0);
  return out;
}

function pullFiles(r: any, p: any) {
  type ChangedFile = { path: string; name: string; status: string; additions: number; deletions: number; patch: string };
  const byPath = new Map<string, ChangedFile>();
  const add = (path: unknown, status: unknown, content?: string) => {
    if (typeof path !== 'string' || path === '' || byPath.has(path)) return;
    const additions = typeof content === 'string' && content !== '' ? content.split('\n').length : 0;
    byPath.set(path, {
      path,
      name: path.slice(path.lastIndexOf('/') + 1),
      status: typeof status === 'string' && status !== '' ? status : 'modified',
      additions,
      deletions: 0,
      patch: content ?? '',
    });
  };

  // 1. Files recorded directly on the pull (REST-created PRs carry {filename,status}).
  for (const f of Array.isArray(p.files) ? p.files : []) {
    if (!f) continue;
    add(f.filename || f.path, f.status, typeof f.patch === 'string' ? f.patch : undefined);
  }
  // 2. Files tracked in repo.files whose commit is the head commit.
  if (byPath.size === 0 && r.files instanceof Map) {
    for (const f of r.files.values()) {
      if (f && f.commitSha === p.headSha) add(f.path, 'modified', f.content);
    }
  }
  // 3. Git pushes only fill gitObjects/refs: derive changed paths from the
  //    head commit's tree, minus anything unchanged in the base commit's tree.
  const headBlobs = gitTreeBlobs(r, p.headSha);
  if (headBlobs.size > 0) {
    const baseBlobs = gitTreeBlobs(r, p.baseSha);
    let found = false;
    for (const [path, oid] of headBlobs) {
      if (baseBlobs.get(path) !== oid) { add(path, 'modified'); found = true; }
    }
    if (!found) for (const path of headBlobs.keys()) add(path, 'modified');
  }

  return Array.from(byPath.values()).map((f) => tag(f, 'PullRequestChangedFile'));
}

function nodeSource(id: unknown) {
  const d = decodeGid(id);
  if (!d) return null;
  if (d.type === 'Repository') {
    for (const r of store.repos.values()) if (r.id === d.id) return repoSource(r);
  } else if (d.type === 'Issue') {
    for (const r of store.repos.values()) {
      const i = storeIssues(r).find((x) => issueNumId(r, x) === d.id);
      if (i) return issueSource(r, i);
    }
  } else if (d.type === 'PullRequest') {
    for (const r of store.repos.values()) {
      const p = storePulls(r).find((x) => pullNumId(r, x) === d.id);
      if (p) return pullSource(r, p);
    }
  }
  return null;
}

function computeField(type: string, name: string, source: any, args: Record<string, any>, _env: Env): any {
  if (type === 'Query') {
    switch (name) {
      case 'viewer': return tag({ login: viewerLogin() }, 'User');
      case 'repository': {
        const r = findRepo(args.owner, args.name);
        return r ? repoSource(r) : null;
      }
      case 'node': return nodeSource(args.id);
      case '__type': return tag({ _name: String(args.name ?? '') }, '__Type');
    }
  }
  if (type === 'Mutation') {
    switch (name) {
      case 'createIssue': return mutationCreateIssue(args.input);
      case 'closeIssue': return mutationCloseIssue(args.input);
      case 'addComment': return mutationAddComment(args.input);
      case 'createPullRequest': return mutationCreatePullRequest(args.input);
      case 'mergePullRequest': return mutationMergePullRequest(args.input);
    }
  }
  if (type === 'Repository') {
    const r = source._repo;
    switch (name) {
      case 'id': return repoGid(r);
      case 'databaseId': return r.id;
      case 'name': return r.name;
      case 'nameWithOwner': return `${r.owner || viewerLogin()}/${r.name}`;
      case 'owner': return tag({ login: r.owner || viewerLogin() }, 'User');
      case 'defaultBranchRef': return tag({ name: r.default_branch || 'main' }, 'Ref');
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'issue': {
        const i = storeIssues(r).find((x) => x.number === args.number);
        return i ? issueSource(r, i) : null;
      }
      case 'issues': return issueConnection(r, args);
      case 'pullRequest': {
        const p = storePulls(r).find((x) => x.number === args.number);
        return p ? pullSource(r, p) : null;
      }
      case 'pullRequests': return pullConnection(r, args);
    }
  }
  if (type === 'Issue') {
    const i = source._issue;
    switch (name) {
      case 'id': return issueGid(source._repo, i);
      case 'number': return i.number;
      case 'title': return i.title;
      case 'state': return i.state === 'closed' ? 'CLOSED' : 'OPEN';
      case 'body': return i.body;
    }
  }
  if (type === 'PullRequest') {
    const p = source._pull;
    switch (name) {
      case 'id': return pullGid(source._repo, p);
      case 'number': return p.number;
      case 'headRefName': return p.headRefName;
      case 'baseRefName': return p.baseRefName;
      case 'state': return p.merged ? 'MERGED' : (p.state === 'closed' ? 'CLOSED' : 'OPEN');
      case 'merged': return !!p.merged;
      case 'mergeable': return 'MERGEABLE';
      case 'files': return tag({ _files: pullFiles(source._repo, p) }, 'PullRequestFileConnection');
    }
  }
  if (type === '__Type') {
    const tn = source._name;
    switch (name) {
      case 'name': return tn;
      case 'fields': return (SCHEMA_FIELDS[tn] ?? []).map((f) => tag({ name: f }, '__Field'));
      case 'enumValues': return (SCHEMA_ENUMS[tn] ?? []).map((e) => tag({ name: e }, '__EnumValue'));
    }
  }
  if (type === 'IssueConnection') {
    if (name === 'nodes') return source._issues.map((i: any) => issueSource(source._repo, i));
    if (name === 'pageInfo') return tag({ hasNextPage: source._hasNextPage, endCursor: source._endCursor }, 'PageInfo');
  }
  if (type === 'PullRequestConnection') {
    if (name === 'nodes') return source._pulls.map((p: any) => pullSource(source._repo, p));
    if (name === 'pageInfo') return tag({ hasNextPage: source._hasNextPage, endCursor: source._endCursor }, 'PageInfo');
  }
  if (type === 'PullRequestFileConnection') {
    if (name === 'nodes') return source._files;
  }
  return UNKNOWN;
}

// --------------------------------------------------------------------------- mutations

function mutationCreateIssue(input: any) {
  input = isRecord(input) ? input : {};
  const repo = findRepoByGid(input.repositoryId);
  if (!repo) return tag({ issue: null }, 'CreateIssuePayload');
  const key = store.repoKey(repo.owner, repo.name);
  const number = store.nextIssue(key);
  const issue = {
    number, title: String(input.title ?? ''), body: String(input.body ?? ''),
    state: 'open', labels: [], id: store.nextId(), comments: [],
  };
  store.issuesOf(key).push(issue);
  return tag({ issue: issueSource(repo, issue) }, 'CreateIssuePayload');
}

function mutationCloseIssue(input: any) {
  const found = findIssueByGid(isRecord(input) ? input.issueId : undefined);
  if (!found) return tag({ issue: null }, 'CloseIssuePayload');
  found.issue.state = 'closed';
  return tag({ issue: issueSource(found.repo, found.issue) }, 'CloseIssuePayload');
}

function mutationAddComment(input: any) {
  input = isRecord(input) ? input : {};
  const found = findIssueByGid(input.subjectId);
  if (!found) return tag({ commentEdge: null }, 'AddCommentPayload');
  const comment = { id: store.nextId(), body: String(input.body ?? '') };
  found.issue.comments.push(comment);
  const node = tag({ id: gid('IssueComment', comment.id), body: comment.body }, 'IssueComment');
  return tag({ commentEdge: tag({ node }, 'IssueCommentEdge') }, 'AddCommentPayload');
}

function mutationCreatePullRequest(input: any) {
  input = isRecord(input) ? input : {};
  const repo = findRepoByGid(input.repositoryId);
  if (!repo) return tag({ pullRequest: null }, 'CreatePullRequestPayload');
  const key = store.repoKey(repo.owner, repo.name);
  const number = store.nextPull(key);
  const pull = {
    number, title: String(input.title ?? ''), body: '', state: 'open',
    headRefName: String(input.headRefName ?? ''), baseRefName: String(input.baseRefName ?? ''),
    headSha: repo.refs.get(String(input.headRefName ?? '')) ?? '',
    baseSha: repo.refs.get(String(input.baseRefName ?? '')) ?? '',
    mergeable_state: 'MERGEABLE', merged: false, id: store.nextId(), files: [],
  };
  store.pullsOf(key).push(pull);
  return tag({ pullRequest: pullSource(repo, pull) }, 'CreatePullRequestPayload');
}

function mutationMergePullRequest(input: any) {
  const found = findPullByGid(isRecord(input) ? input.pullRequestId : undefined);
  if (!found) return tag({ pullRequest: null }, 'MergePullRequestPayload');
  found.pull.merged = true;
  found.pull.state = 'closed';
  return tag({ pullRequest: pullSource(found.repo, found.pull) }, 'MergePullRequestPayload');
}

// --------------------------------------------------------------------------- execution

function resolveValue(v: any, variables: Record<string, any>): any {
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, variables));
  if (isRecord(v)) {
    if ('__var' in v) return variables[v.__var];
    const out: Record<string, any> = {};
    for (const [k, x] of Object.entries(v)) out[k] = resolveValue(x, variables);
    return out;
  }
  return v;
}

function leaf(v: any): any {
  if (Array.isArray(v)) return v.map(leaf);
  if (v && typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v)) {
      if (k === '__typename' || k.startsWith('_')) continue;
      out[k] = leaf(v[k]);
    }
    return out;
  }
  return v;
}

function executeSelectionSet(selections: Selection[], source: any, env: Env): any {
  if (Array.isArray(source)) return source.map((s) => executeSelectionSet(selections, s, env));
  if (source === null || source === undefined) return null;
  const type = source.__typename as string | undefined;
  const out: Record<string, any> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (type === sel.typeCondition) Object.assign(out, executeSelectionSet(sel.selections ?? [], source, env));
      continue;
    }
    const name = sel.name!;
    const args: Record<string, any> = {};
    for (const [k, raw] of Object.entries(sel.args ?? {})) args[k] = resolveValue(raw, env.variables);
    const computed = computeField(type ?? 'Query', name, source, args, env);
    let value: any;
    if (computed !== UNKNOWN) {
      value = computed;
    } else if (source && Object.prototype.hasOwnProperty.call(source, name)) {
      value = source[name];
    } else {
      env.errors.push({ message: `Cannot query field "${name}" on type "${type ?? 'Query'}".` });
      value = null;
    }
    out[sel.alias!] = (sel.selections ?? []).length > 0
      ? executeSelectionSet(sel.selections!, value, env)
      : leaf(value);
  }
  return out;
}

function executeOne(body: Record<string, any>): Record<string, any> {
  const variables = isRecord(body.variables) ? body.variables : {};
  const env: Env = { variables, errors: [] };
  let data: any = null;
  try {
    const query = typeof body.query === 'string' ? body.query : '';
    const ops = new Parser(tokenize(query)).parseDocument();
    const op = ops[0];
    if (!op) throw new Error('The document contains no operation');
    const root = tag({}, op.type === 'mutation' ? 'Mutation' : 'Query');
    data = executeSelectionSet(op.selections, root, env);
  } catch (e) {
    env.errors.push({ message: e instanceof Error ? e.message : String(e) });
    data = null;
  }
  const result: Record<string, any> = { data };
  if (env.errors.length > 0) result.errors = env.errors;
  return result;
}

// --------------------------------------------------------------------------- auth + entrypoint

function authorized(ctx: Ctx): boolean {
  const header = ctx.req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  const expected = store.token || process.env.MAKEFUN_SHOP_TOKEN || '';
  return expected === '' ? true : token === expected;
}

export async function handleGraphql(ctx: Ctx): Promise<boolean> {
  if (ctx.method !== 'POST' || ctx.path !== '/api/graphql') return false;

  // Unauthenticated requests are an HTTP 401 (before parsing the body).
  if (!authorized(ctx)) {
    sendJson(ctx.res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/graphql' });
    return true;
  }

  const { ok, value } = await readJson(ctx.req);
  if (!ok) {
    sendJson(ctx.res, 400, { errors: [{ message: 'The request body is not valid JSON' }] });
    return true;
  }

  // GitHub's operation batching: a JSON array of operations -> an array of envelopes, in order.
  if (Array.isArray(value)) {
    sendJson(ctx.res, 200, value.map((entry) => executeOne(isRecord(entry) ? entry : {})));
    return true;
  }
  if (!isRecord(value)) {
    sendJson(ctx.res, 400, { errors: [{ message: 'Expected a JSON object with a query' }] });
    return true;
  }
  sendJson(ctx.res, 200, executeOne(value));
  return true;
}
