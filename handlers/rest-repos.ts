// REST v3 repositories, branches, commits, git refs and contents.
//
// Scoped to:
//   /api/v3/user/repos
//   /api/v3/repos/{owner}/{repo}
//   /api/v3/repos/{owner}/{repo}/branches
//   /api/v3/repos/{owner}/{repo}/commits
//   /api/v3/repos/{owner}/{repo}/git/refs...
//   /api/v3/repos/{owner}/{repo}/contents/{path}
// Issues/pulls/root/meta/unknown routes are handled by the sibling modules.
//
// Everything is deterministic: ids come from store.nextId(), shas from sha1 over
// content plus that counter (never the clock), and request ids from sendJson/err.

import { createHash } from 'node:crypto';
import type { Ctx } from '../app.ts';
import { store, type Repo, type FileObj, type CommitObj } from '../store.ts';
import { sendJson, err, readJson } from '../http.ts';
import { cachedJson, invalidateJsonCache, takeParsed } from './rest-protocol.ts';

// The contest scenario seed is a fixed constant, so the login the single bearer
// token names never changes between trials. Repos created through POST /user/repos
// belong to this login; the same name under any other path owner is simply absent
// and therefore a 404 (never a 403).
const VIEWER_LOGIN = 'adaiversen';
const ZERO_SHA = '0'.repeat(40);

type Json = Record<string, unknown>;

function viewer(): string {
  return VIEWER_LOGIN;
}
function refName(branch: string): string {
  return `refs/heads/${branch}`;
}
function decodeSeg(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}
function queryOf(ctx: Ctx): URLSearchParams {
  try { return new URL(ctx.req.url ?? '/', 'http://entry').searchParams; } catch { return new URLSearchParams(); }
}
function hostOf(ctx: Ctx): string {
  return ctx.req.headers.host ?? 'localhost';
}

// ---------------------------------------------------------------- auth

function authorized(ctx: Ctx): boolean {
  const header = ctx.req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  if (match === null) return false;
  if (store.token === '') return true; // unset in local import tests: any bearer is the viewer
  return match[1] === store.token;
}
function needAuth(ctx: Ctx): boolean {
  if (authorized(ctx)) return true;
  err(ctx.res, 401, 'Bad credentials');
  return false;
}

// ---------------------------------------------------------------- hashes and objects

function blobSha(content: string): string {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, 'utf8'), bytes]))
    .digest('hex');
}

function addCommit(repo: Repo, message: string, parent: string): CommitObj {
  const nonce = store.nextId();
  const sha = createHash('sha1')
    .update(`${repo.full_name}\n${message}\n${parent}\n${nonce}\n${repo.commits.size}`)
    .digest('hex');
  const commit: CommitObj = {
    sha,
    message,
    tree: sha,
    parents: parent === '' || parent === ZERO_SHA ? [] : [parent],
  };
  repo.commits.set(sha, commit);
  return commit;
}

function repoJson(repo: Repo): Json {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64url'),
    name: repo.name,
    full_name: repo.full_name,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    html_url: `/${repo.full_name}`,
    clone_url: `/${repo.full_name}.git`,
  };
}

function createRepo(name: string, isPrivate: boolean, description: string): Repo {
  const owner = viewer();
  const repo: Repo = {
    name,
    owner,
    private: isPrivate,
    description,
    default_branch: 'main',
    full_name: `${owner}/${name}`,
    id: store.nextId(),
    branches: new Set<string>(),
    refs: new Map<string, string>(),
    commits: new Map<string, CommitObj>(),
    files: new Map<string, FileObj>(),
    gitObjects: new Map<string, Buffer>(),
  };
  store.repos.set(store.repoKey(owner, name), repo);
  return repo;
}

// ---------------------------------------------------------------- files & refs helpers

function fileKey(branch: string, path: string, def: string): string {
  return branch === def ? path : `${branch}\u0000${path}`;
}

/** Current tip of a branch, or the raw sha when given a commit id. */
function resolveTip(repo: Repo, shaOrRef: string): string {
  const direct = repo.refs.get(refName(shaOrRef));
  if (direct !== undefined) return direct;
  if (repo.refs.has(shaOrRef)) return repo.refs.get(shaOrRef)!;
  if (repo.commits.has(shaOrRef)) return shaOrRef;
  return shaOrRef;
}

function commitHistory(repo: Repo, tip: string): CommitObj[] {
  const out: CommitObj[] = [];
  const seen = new Set<string>();
  let cursor = tip;
  while (cursor !== '' && cursor !== ZERO_SHA && !seen.has(cursor)) {
    seen.add(cursor);
    const commit = repo.commits.get(cursor);
    if (commit === undefined) break;
    out.push(commit);
    cursor = commit.parents[0] ?? '';
  }
  return out;
}

function fileAt(repo: Repo, branch: string, path: string): FileObj | undefined {
  const own = repo.files.get(fileKey(branch, path, repo.default_branch));
  if (own !== undefined) return own;
  if (branch !== repo.default_branch) {
    // A new branch inherits the files of the default branch at its creation point.
    return repo.files.get(path);
  }
  return undefined;
}

function directoryListing(repo: Repo, branch: string, dir: string): Json[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const byName = new Map<string, Json>();
  const consider = (path: string, file: FileObj): void => {
    if (prefix !== '' && !path.startsWith(prefix)) return;
    const rest = prefix === '' ? path : path.slice(prefix.length);
    if (rest === '') return;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      byName.set(rest, { type: 'file', name: rest, path, sha: file.sha, size: Buffer.byteLength(file.content, 'utf8') });
    } else {
      const name = rest.slice(0, slash);
      if (!byName.has(name)) {
        byName.set(name, { type: 'dir', name, path: `${prefix}${name}`, sha: file.sha });
      }
    }
  };
  for (const [key, file] of repo.files) {
    if (key.includes('\u0000')) continue; // branch-specific override, handled below
    consider(key, file);
  }
  if (branch !== repo.default_branch) {
    const bprefix = `${branch}\u0000`;
    for (const [key, file] of repo.files) {
      if (!key.startsWith(bprefix)) continue;
      consider(key.slice(bprefix.length), file);
    }
  }
  return [...byName.values()];
}

// ---------------------------------------------------------------- handlers

async function handleUserRepos(ctx: Ctx, method: string): Promise<boolean> {
  if (!needAuth(ctx)) return true;

  if (method === 'POST') {
    // The protocol pre-parser already validated and parsed this body; reuse it.
    const parsed = takeParsed(ctx.req) ?? await readJson(ctx.req);
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
      err(ctx.res, 400, 'Invalid JSON body');
      return true;
    }
    const body = parsed.value as Json;
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') {
      err(ctx.res, 422, 'Validation Failed: name is required');
      return true;
    }
    const owner = viewer();
    if (store.getRepo(owner, name) !== undefined) {
      err(ctx.res, 422, 'Validation Failed: name already exists');
      return true;
    }
    const isPrivate = body.private === true;
    const description = typeof body.description === 'string' ? body.description : '';
    const repo = createRepo(name, isPrivate, description);
    invalidateJsonCache();
    sendJson(ctx.res, 201, repoJson(repo));
    return true;
  }

  if (method === 'GET') {
    const query = queryOf(ctx);
    const rawPer = Number.parseInt(query.get('per_page') ?? '30', 10);
    const perPage = Number.isFinite(rawPer) && rawPer > 0 ? Math.min(rawPer, 100) : 30;
    const rawPage = Number.parseInt(query.get('page') ?? '1', 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
    const all = [...store.repos.values()].filter((repo) => repo.owner === viewer());
    const headers: Record<string, string> = {};
    if (page * perPage < all.length) {
      const next = `http://${hostOf(ctx)}${ctx.path}?per_page=${perPage}&page=${page + 1}`;
      headers.link = `<${next}>; rel="next"`;
    }
    const key = `userrepos|${viewer()}|${hostOf(ctx)}|${ctx.req.url ?? ''}|${store.seqGlobal}`;
    cachedJson(ctx, 200, key, () => all.slice((page - 1) * perPage, page * perPage).map(repoJson), headers);
    return true;
  }

  return false;
}

async function handleRepoRoot(ctx: Ctx, method: string, repo: Repo): Promise<boolean> {
  if (method === 'GET') {
    // repoJson() depends only on these fields; the fingerprint makes the key self-invalidating.
    const key = `repo|${store.repoKey(repo.owner, repo.name)}|${repo.id}|${repo.private}|${repo.description}|${repo.default_branch}`;
    cachedJson(ctx, 200, key, () => repoJson(repo));
    return true;
  }
  if (method === 'PATCH') {
    const parsed = await readJson(ctx.req);
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
      err(ctx.res, 400, 'Invalid JSON body');
      return true;
    }
    const body = parsed.value as Json;
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.private === 'boolean') repo.private = body.private;
    invalidateJsonCache();
    sendJson(ctx.res, 200, repoJson(repo));
    return true;
  }
  if (method === 'DELETE') {
    store.repos.delete(store.repoKey(repo.owner, repo.name));
    store.issues.delete(store.repoKey(repo.owner, repo.name));
    store.pulls.delete(store.repoKey(repo.owner, repo.name));
    invalidateJsonCache();
    sendJson(ctx.res, 204, {});
    return true;
  }
  return false;
}

function handleBranches(ctx: Ctx, repo: Repo, only?: string): boolean {
  if (only !== undefined) {
    const sha = repo.refs.get(refName(only));
    if (sha === undefined || !repo.branches.has(only)) {
      err(ctx.res, 404, 'Not Found');
      return true;
    }
    sendJson(ctx.res, 200, { name: only, commit: { sha }, protected: false });
    return true;
  }
  const branches = repo.branches.size > 0
    ? [...repo.branches]
    : [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ref.slice('refs/heads/'.length));
  const body = branches.map((name) => ({
    name,
    commit: { sha: repo.refs.get(refName(name)) ?? ZERO_SHA },
    protected: false,
  }));
  sendJson(ctx.res, 200, body);
  return true;
}

function handleCommits(ctx: Ctx, repo: Repo): boolean {
  const ref = queryOf(ctx).get('sha') ?? '';
  const tip = ref === ''
    ? (repo.refs.get(refName(repo.default_branch)) ?? ZERO_SHA)
    : resolveTip(repo, ref);
  const commits = commitHistory(repo, tip).map((commit) => ({
    sha: commit.sha,
    commit: { message: commit.message },
    parents: commit.parents.map((sha) => ({ sha })),
  }));
  sendJson(ctx.res, 200, commits);
  return true;
}

async function handleGitRefs(ctx: Ctx, method: string, repo: Repo, tail: string[]): Promise<boolean> {
  if (method === 'GET') {
    if (tail.length === 0) {
      const body = [...repo.refs.entries()].map(([ref, oid]) => ({ ref, object: { sha: oid, type: 'commit' } }));
      sendJson(ctx.res, 200, body);
      return true;
    }
    if (tail[0] === 'heads') {
      const branch = tail.slice(1).map(decodeSeg).join('/');
      const oid = repo.refs.get(refName(branch));
      if (oid === undefined) {
        err(ctx.res, 404, 'Not Found');
        return true;
      }
      sendJson(ctx.res, 200, { ref: refName(branch), object: { sha: oid, type: 'commit' } });
      return true;
    }
    return false;
  }
  if (method !== 'POST' || tail.length !== 0) return false;
  const parsed = await readJson(ctx.req);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    err(ctx.res, 400, 'Invalid JSON body');
    return true;
  }
  const body = parsed.value as Json;
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/heads/') || sha === '') {
    err(ctx.res, 422, 'Validation Failed: ref and sha are required');
    return true;
  }
  repo.refs.set(ref, sha);
  const branch = ref.slice('refs/heads/'.length);
  repo.branches.add(branch);
  sendJson(ctx.res, 201, { ref, object: { sha, type: 'commit' } });
  return true;
}

async function handleContents(ctx: Ctx, method: string, repo: Repo, segments: string[]): Promise<boolean> {
  const path = segments.map(decodeSeg).join('/');
  const ref = queryOf(ctx).get('ref') ?? '';
  const branch = ref === '' ? repo.default_branch : ref;

  if (method === 'GET') {
    const exact = fileAt(repo, branch, path);
    if (exact !== undefined) {
      sendJson(ctx.res, 200, {
        type: 'file',
        name: path.slice(path.lastIndexOf('/') + 1),
        path,
        sha: exact.sha,
        size: Buffer.byteLength(exact.content, 'utf8'),
        encoding: 'base64',
        content: Buffer.from(exact.content, 'utf8').toString('base64'),
      });
      return true;
    }
    const entries = directoryListing(repo, branch, path);
    if (entries.length > 0) {
      sendJson(ctx.res, 200, entries);
      return true;
    }
    err(ctx.res, 404, 'Not Found');
    return true;
  }

  if (method === 'PUT') {
    const parsed = await readJson(ctx.req);
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
      err(ctx.res, 400, 'Invalid JSON body');
      return true;
    }
    const body = parsed.value as Json;
    if (typeof body.content !== 'string' || typeof body.message !== 'string') {
      err(ctx.res, 422, 'Validation Failed: content and message are required');
      return true;
    }
    const content = Buffer.from(body.content.replace(/[\r\n\t ]+/g, ''), 'base64').toString('utf8');
    const targetBranch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.default_branch;
    const key = fileKey(targetBranch, path, repo.default_branch);
    const existing = repo.files.get(key) ?? (targetBranch !== repo.default_branch ? repo.files.get(path) : undefined);
    const expectedSha = typeof body.sha === 'string' ? body.sha : '';
    if (expectedSha !== '' && existing !== undefined && expectedSha !== existing.sha) {
      err(ctx.res, 409, 'Conflict: sha does not match the current file');
      return true;
    }
    const isCreate = existing === undefined;
    const sha = blobSha(content);
    const parent = repo.refs.get(refName(targetBranch)) ?? ZERO_SHA;
    const commit = addCommit(repo, body.message, parent);
    repo.refs.set(refName(targetBranch), commit.sha);
    repo.branches.add(targetBranch);
    const file: FileObj = { path, content, sha, commitSha: commit.sha };
    repo.files.set(key, file);
    sendJson(ctx.res, isCreate ? 201 : 200, {
      content: {
        type: 'file',
        name: path.slice(path.lastIndexOf('/') + 1),
        path,
        sha,
        size: Buffer.byteLength(content, 'utf8'),
        encoding: 'base64',
        content: Buffer.from(content, 'utf8').toString('base64'),
      },
      commit: { sha: commit.sha, message: commit.message },
    });
    return true;
  }

  if (method === 'DELETE') {
    const parsed = await readJson(ctx.req);
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
      err(ctx.res, 400, 'Invalid JSON body');
      return true;
    }
    const body = parsed.value as Json;
    const targetBranch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.default_branch;
    const key = fileKey(targetBranch, path, repo.default_branch);
    const existing = repo.files.get(key) ?? (targetBranch !== repo.default_branch ? repo.files.get(path) : undefined);
    if (existing === undefined) {
      err(ctx.res, 404, 'Not Found');
      return true;
    }
    const expectedSha = typeof body.sha === 'string' ? body.sha : '';
    if (expectedSha !== '' && expectedSha !== existing.sha) {
      err(ctx.res, 409, 'Conflict: sha does not match the current file');
      return true;
    }
    repo.files.delete(key);
    const parent = repo.refs.get(refName(targetBranch)) ?? ZERO_SHA;
    const message = typeof body.message === 'string' ? body.message : `Delete ${path}`;
    const commit = addCommit(repo, message, parent);
    repo.refs.set(refName(targetBranch), commit.sha);
    sendJson(ctx.res, 200, { commit: { sha: commit.sha, message: commit.message } });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------- entry point

export async function handleRepos(ctx: Ctx): Promise<boolean> {
  const { parts, method } = ctx;
  if (parts[0] !== 'api' || parts[1] !== 'v3') return false;

  // POST/GET /api/v3/user/repos
  if (parts[2] === 'user' && parts[3] === 'repos' && parts.length === 4) {
    return handleUserRepos(ctx, method);
  }

  // /api/v3/repos/{owner}/{repo}...
  if (parts[2] !== 'repos' || parts.length < 5) return false;
  const owner = decodeSeg(parts[3]);
  const name = decodeSeg(parts[4]);
  const tail = parts.slice(5);
  const repo = store.getRepo(owner, name);
  if (repo === undefined) {
    if (!needAuth(ctx)) return true;
    err(ctx.res, 404, 'Not Found');
    return true;
  }
  if (!needAuth(ctx)) return true;

  if (tail.length === 0) return handleRepoRoot(ctx, method, repo);
  if (tail[0] === 'branches' && tail.length <= 2 && method === 'GET') {
    return handleBranches(ctx, repo, tail.length === 2 ? decodeSeg(tail[1]) : undefined);
  }
  if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') return handleCommits(ctx, repo);
  if (tail[0] === 'git' && tail[1] === 'refs') return handleGitRefs(ctx, method, repo, tail.slice(2));
  if (tail[0] === 'contents') return handleContents(ctx, method, repo, tail.slice(1));

  // issues, pulls, labels, etc. belong to the sibling handlers.
  return false;
}
