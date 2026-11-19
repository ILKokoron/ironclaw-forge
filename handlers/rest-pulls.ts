// REST v3 pull requests: POST/GET /pulls, GET /pulls/{n}, GET /pulls/{n}/files,
// PUT /pulls/{n}/merge. All state lives in the shared store so REST / GraphQL / MCP agree.
import { createHash } from 'node:crypto';
import type { Ctx } from '../app.ts';
import { store, type Repo, type Pull } from '../store.ts';
import { err, readJson, sendJson } from '../http.ts';
import { cachedJson, invalidateJsonCache } from './rest-protocol.ts';

type PullEx = Pull & { mergedAt?: string; mergeCommitSha?: string };

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

/** A ref may be stored bare, under refs/heads/, or under refs/remotes/origin/. */
function refSha(repo: Repo, ref: string): string | undefined {
  const keys = [ref, `refs/heads/${ref}`, `refs/remotes/origin/${ref}`];
  for (const key of keys) {
    const value = repo.refs.get(key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function setRefSha(repo: Repo, ref: string, sha: string): void {
  repo.refs.set(ref, sha);
  repo.refs.set(`refs/heads/${ref}`, sha);
  if (ref.startsWith('refs/heads/')) repo.refs.set(ref.slice('refs/heads/'.length), sha);
}

/** The root commit stands in for a default branch whose tip was never recorded in refs. */
function rootCommit(repo: Repo): string | undefined {
  for (const commit of repo.commits.values()) {
    if (commit.parents.length === 0) return commit.sha;
  }
  return undefined;
}

function reachable(repo: Repo, tip?: string): Set<string> {
  const seen = new Set<string>();
  if (!tip) return seen;
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const commit = repo.commits.get(sha);
    if (commit) for (const parent of commit.parents) if (!seen.has(parent)) stack.push(parent);
  }
  return seen;
}

/** A files-map key is either a plain path (default branch) or `branch\u0000path` for a branch override. */
function plainPath(key: string): string {
  const nul = key.indexOf('\u0000');
  return nul === -1 ? key : key.slice(nul + 1);
}

/** Resolve the file object backing a pull-request path: head override first, then the plain/default key. */
function pullFileBlob(repo: Repo, pull: PullEx, filename: string): { path: string; content: string; sha: string; commitSha: string } | undefined {
  return repo.files.get(`${pull.headRefName}\u0000${filename}`)
    ?? repo.files.get(filename)
    ?? repo.files.get(`${pull.baseRefName}\u0000${filename}`);
}

/** Paths changed on the head branch relative to the base, with a robust fallback. */
function changedFiles(repo: Repo, headSha: string, baseSha: string): { filename: string; status: string }[] {
  const head = reachable(repo, headSha);
  const base = reachable(repo, baseSha);
  const out: { filename: string; status: string }[] = [];
  for (const [key, file] of repo.files) {
    if (file.commitSha !== baseSha && (head.has(file.commitSha) || !base.has(file.commitSha))) {
      out.push({ filename: plainPath(key), status: 'modified' });
    }
  }
  if (out.length === 0) {
    for (const [key, file] of repo.files) {
      if (file.commitSha === headSha) out.push({ filename: plainPath(key), status: 'modified' });
    }
  }
  if (out.length === 0) {
    for (const key of repo.files.keys()) out.push({ filename: plainPath(key), status: 'modified' });
  }
  return out;
}

function pullView(pull: PullEx): Record<string, unknown> {
  const view: Record<string, unknown> = {
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRefName, sha: pull.headSha },
    base: { ref: pull.baseRefName, sha: pull.baseSha },
    merged: pull.merged === true,
    id: pull.id,
  };
  if (pull.merged) {
    view.merge_commit_sha = pull.mergeCommitSha ?? '';
    view.merged_at = pull.mergedAt ?? '';
  }
  return view;
}

/** Deterministic per-process counter folded into each squash commit id. */
let mergeSeq = 0;

export async function handlePulls(ctx: Ctx): Promise<boolean> {
  const { method, parts, res } = ctx;
  if (parts.length < 6) return false;
  if (parts[0] !== 'api' || parts[1] !== 'v3' || parts[2] !== 'repos') return false;
  if (parts[5] !== 'pulls') return false;

  const owner = decodeURIComponent(parts[3]);
  const repoName = decodeURIComponent(parts[4]);
  const repo = store.getRepo(owner, repoName);
  if (!repo) { err(res, 404, 'Not Found'); return true; }

  const repoKey = store.repoKey(owner, repoName);
  const pulls = store.pullsOf(repoKey);
  const tail = parts.slice(6);

  // POST /repos/{owner}/{repo}/pulls
  if (method === 'POST' && tail.length === 0) {
    const parsed = await readJson(ctx.req);
    if (!parsed.ok) { err(res, 400, 'Invalid JSON body'); return true; }
    const body = (parsed.value ?? {}) as Record<string, unknown>;
    const head = typeof body.head === 'string' ? body.head : '';
    const base = typeof body.base === 'string' && body.base !== '' ? body.base : repo.default_branch;
    const headSha = refSha(repo, head);
    if (head === '' || headSha === undefined) {
      err(res, 422, `Head ref "${head}" does not exist in this repository`);
      return true;
    }
    const baseSha = refSha(repo, base) ?? rootCommit(repo) ?? '';
    const pull: PullEx = {
      number: store.nextPull(repoKey),
      title: typeof body.title === 'string' ? body.title : '',
      body: typeof body.body === 'string' ? body.body : '',
      state: 'open',
      headRefName: head,
      baseRefName: base,
      headSha,
      baseSha,
      mergeable_state: 'clean',
      merged: false,
      id: store.nextId(),
      files: changedFiles(repo, headSha, baseSha),
    };
    pulls.push(pull);
    sendJson(res, 201, pullView(pull));
    return true;
  }

  // GET /repos/{owner}/{repo}/pulls
  if (method === 'GET' && tail.length === 0) {
    const state = (new URL(ctx.req.url ?? '/', 'http://entry').searchParams.get('state') ?? 'open').toLowerCase();
    let list = pulls;
    if (state === 'open' || state === 'closed') list = pulls.filter((pull) => pull.state === state);
    sendJson(res, 200, list.map(pullView));
    return true;
  }

  // GET /repos/{owner}/{repo}/pulls/{n}
  if (method === 'GET' && tail.length === 1) {
    const number = Number(tail[0]);
    const pull = pulls.find((item) => item.number === number);
    if (!pull) { err(res, 404, 'Not Found'); return true; }
    sendJson(res, 200, pullView(pull));
    return true;
  }

  // GET /repos/{owner}/{repo}/pulls/{n}/files
  if (method === 'GET' && tail.length === 2 && tail[1] === 'files') {
    const number = Number(tail[0]);
    const pull = pulls.find((item) => item.number === number);
    if (!pull) { err(res, 404, 'Not Found'); return true; }
    const files = (pull.files ?? []).map((file) => {
      const blob = pullFileBlob(repo, pull, file.filename);
      const content = blob?.content ?? '';
      const additions = content.length > 0 ? Math.max(1, content.split('\n').length) : 1;
      return {
        filename: file.filename,
        status: file.status || 'modified',
        additions,
        deletions: 0,
        changes: additions,
        sha: blob?.sha ?? sha1(content),
        patch: content,
      };
    });
    sendJson(res, 200, files);
    return true;
  }

  // PUT /repos/{owner}/{repo}/pulls/{n}/merge
  if (method === 'PUT' && tail.length === 2 && tail[1] === 'merge') {
    const number = Number(tail[0]);
    const pull = pulls.find((item) => item.number === number) as PullEx | undefined;
    if (!pull) { err(res, 404, 'Not Found'); return true; }

    // A self-merge, a PR whose base has advanced since it opened, or a second
    // merge all mean the squash cannot be applied cleanly.
    const currentBase = refSha(repo, pull.baseRefName) ?? rootCommit(repo);
    if (pull.headRefName === pull.baseRefName || pull.merged ||
        (currentBase !== undefined && currentBase !== pull.baseSha)) {
      err(res, 405, 'Pull Request is conflicted and cannot be merged');
      return true;
    }

    mergeSeq += 1;
    const sha = sha1(`merge:${repoKey}:${pull.number}:${mergeSeq}`);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergeCommitSha = sha;
    pull.mergedAt = process.env.MAKEFUN_TRIAL_NOW ?? '2026-01-01T00:00:00Z';

    // Land the squash on the base branch: a commit plus a moved tip makes it
    // appear in GET /commits?sha=<base>, and head-only files move to the merge
    // commit so GET /contents?ref=<base> serves the merged bytes.
    repo.commits.set(sha, {
      sha,
      message: `Merge pull request #${pull.number} from ${pull.headRefName}`,
      tree: sha1(`tree:${sha}`),
      parents: pull.baseSha ? [pull.baseSha] : [],
    });
    const baseReach = reachable(repo, pull.baseSha);
    const headReach = reachable(repo, pull.headSha);
    const baseKey = (p: string): string => pull.baseRefName === repo.default_branch ? p : `${pull.baseRefName}\u0000${p}`;
    const toLand: { key: string; file: { path: string; content: string; sha: string; commitSha: string } }[] = [];
    for (const [key, file] of repo.files) {
      if (headReach.has(file.commitSha) && !baseReach.has(file.commitSha)) {
        const path = plainPath(key);
        toLand.push({ key: baseKey(path), file: { ...file, path, commitSha: sha } });
      }
    }
    for (const entry of toLand) repo.files.set(entry.key, entry.file);
    setRefSha(repo, pull.baseRefName, sha);
    if (!repo.branches.has(pull.baseRefName)) repo.branches.add(pull.baseRefName);

    sendJson(res, 200, {
      sha,
      merged: true,
      message: 'Pull Request successfully merged and closed',
      merge_commit_sha: sha,
    });
    return true;
  }

  return false;
}
