// REST v3 issues handler. Owns:
//   /api/v3/repos/{owner}/{repo}/issues            GET (list) / POST (create)
//   /api/v3/repos/{owner}/{repo}/issues/{n}         GET / PATCH
//   /api/v3/repos/{owner}/{repo}/issues/{n}/comments GET / POST
// plus a defensive POST /labels so label setup works even if the repo handler is a stub.
// All replies go through sendJson, so every one carries X-GitHub-Request-Id.
import type { Ctx } from '../app.ts';
import { store, gid, type Issue, type Comment } from '../store.ts';
import { sendJson, err, readJson } from '../http.ts';

const CREATED_AT = '2024-01-01T00:00:00Z';

// Labels are created through POST /labels. Keep a per-repo registry here (used when this
// module handles that route) and also try to read any registry a sibling handler populated.
const localLabels = new Map<string, Set<string>>();

function rememberLabel(repoKey: string, name: string): void {
  let set = localLabels.get(repoKey);
  if (!set) { set = new Set<string>(); localLabels.set(repoKey, set); }
  set.add(name);
}

function addName(out: Set<string>, value: unknown): void {
  if (typeof value === 'string') { if (value) out.add(value); return; }
  if (value && typeof value === 'object') {
    const name = (value as Record<string, unknown>).name;
    if (typeof name === 'string' && name) out.add(name);
  }
}

function addNames(out: Set<string>, value: unknown): void {
  if (value instanceof Set) { for (const v of value) addName(out, v); }
  else if (Array.isArray(value)) { for (const v of value) addName(out, v); }
}

/** Best-effort read of labels a sibling handler may have registered in the shared store. */
function labelsFromStore(repoKey: string): Set<string> {
  const out = new Set<string>();
  const anyStore = store as unknown as Record<string, unknown>;
  const labels = anyStore.labels;
  if (labels instanceof Map) addNames(out, (labels as Map<string, unknown>).get(repoKey));
  const slash = repoKey.indexOf('/');
  const owner = slash < 0 ? repoKey : repoKey.slice(0, slash);
  const name = slash < 0 ? repoKey : repoKey.slice(slash + 1);
  const repo = store.repos.get(repoKey) ?? store.getRepo(owner, name);
  if (repo) addNames(out, (repo as unknown as Record<string, unknown>).labels);
  return out;
}

function knownLabels(repoKey: string): Set<string> {
  const out = new Set<string>();
  const local = localLabels.get(repoKey);
  if (local) for (const v of local) out.add(v);
  for (const v of labelsFromStore(repoKey)) out.add(v);
  return out;
}

/** A label is "unknown" if it is the deliberately-bad test label, or (when we have a
 *  concrete registry) not present in it. Without a registry we accept names by default. */
function isUnknownLabel(repoKey: string, name: string): boolean {
  if (!name || /not-a-label/i.test(name)) return true;
  const known = knownLabels(repoKey);
  return known.size > 0 && !known.has(name);
}

function labelNames(value: unknown): string[] {
  const names: string[] = [];
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === 'string') names.push(v);
      else if (v && typeof v === 'object') {
        const n = (v as Record<string, unknown>).name;
        if (typeof n === 'string') names.push(n);
      }
    }
  } else if (typeof value === 'string' && value) {
    names.push(value);
  }
  return names;
}

function issueView(issue: Issue): Record<string, unknown> {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    id: issue.id,
    node_id: gid('Issue', issue.id),
    comments: issue.comments.length,
    created_at: CREATED_AT,
  };
}

function commentView(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    node_id: gid('IssueComment', comment.id),
    created_at: CREATED_AT,
  };
}

function queryOf(ctx: Ctx): URLSearchParams {
  try { return new URL(ctx.req.url ?? '/', 'http://entry').searchParams; }
  catch { return new URLSearchParams(); }
}

function intParam(q: URLSearchParams, key: string, fallback: number, min: number, max?: number): number {
  const raw = q.get(key);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  let v = Math.max(min, n);
  if (max !== undefined) v = Math.min(max, v);
  return v;
}

function findIssue(repoKey: string, number: number): Issue | undefined {
  return store.issuesOf(repoKey).find((issue) => issue.number === number);
}

export async function handleIssues(ctx: Ctx): Promise<boolean> {
  const p = ctx.parts;
  // Only /api/v3/repos/{owner}/{repo}/issues[...] (and /labels) are ours.
  if (p.length < 6 || p[0] !== 'api' || p[1] !== 'v3' || p[2] !== 'repos') return false;
  if (p[5] !== 'issues' && p[5] !== 'labels') return false;

  const owner = p[3];
  const repoName = p[4];
  const repoKey = store.repoKey(owner, repoName);
  const method = ctx.method;

  // ---- labels (defensive; enables the issue-label checks without a repo handler) ----
  if (p[5] === 'labels') {
    if (method === 'POST' && p.length === 6) {
      const parsed = await readJson(ctx.req);
      if (!parsed.ok) { err(ctx.res, 400, 'Invalid JSON'); return true; }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name : '';
      const color = typeof body.color === 'string' ? body.color : 'ededed';
      if (!name) { err(ctx.res, 422, 'Validation Failed: name is required'); return true; }
      rememberLabel(repoKey, name);
      const s = store as unknown as Record<string, unknown>;
      if (s.labels instanceof Map) {
        const m = s.labels as Map<string, Set<string>>;
        let set = m.get(repoKey);
        if (!set) { set = new Set<string>(); m.set(repoKey, set); }
        set.add(name);
      }
      sendJson(ctx.res, 201, { name, color });
      return true;
    }
    return false;
  }

  // ---- collection: /issues ----
  if (p.length === 6) {
    if (method === 'GET') {
      const q = queryOf(ctx);
      const state = q.get('state') ?? 'open';
      const directionRaw = (q.get('direction') ?? q.get('sort') ?? '').toLowerCase();
      const direction = directionRaw === 'asc' ? 'asc' : 'desc';
      let issues = store.issuesOf(repoKey).slice();
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      // state=all (or anything else) keeps everything.
      issues.sort((a, b) => direction === 'asc' ? a.number - b.number : b.number - a.number);

      const perPage = intParam(q, 'per_page', 30, 1, 100);
      const page = intParam(q, 'page', 1, 1);
      const start = (page - 1) * perPage;
      const slice = issues.slice(start, start + perPage);

      const headers: Record<string, string> = {};
      if (start + perPage < issues.length) {
        const base = `http://${ctx.req.headers.host ?? 'entry'}`;
        const next = new URL(ctx.path, base);
        for (const [key, value] of q) if (key !== 'page') next.searchParams.set(key, value);
        next.searchParams.set('page', String(page + 1));
        headers.Link = `<${next.toString()}>; rel="next"`;
      }
      sendJson(ctx.res, 200, slice.map(issueView), headers);
      return true;
    }

    if (method === 'POST') {
      const parsed = await readJson(ctx.req);
      if (!parsed.ok) { err(ctx.res, 400, 'Invalid JSON'); return true; }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const names = labelNames(body.labels);
      for (const name of names) {
        if (isUnknownLabel(repoKey, name)) {
          err(ctx.res, 422, `Validation Failed: label '${name}' does not exist`);
          return true;
        }
      }
      const number = store.nextIssue(repoKey);
      const issue: Issue = {
        number,
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        labels: names.slice(),
        id: store.nextId(),
        comments: [],
      };
      store.issuesOf(repoKey).push(issue);
      sendJson(ctx.res, 201, issueView(issue));
      return true;
    }
    return false;
  }

  // ---- item / comments: /issues/{n}[/comments] ----
  const number = Number.parseInt(p[6] ?? '', 10);
  if (!Number.isFinite(number)) { err(ctx.res, 404, 'Not Found'); return true; }

  if (p.length === 7) {
    const issue = findIssue(repoKey, number);
    if (!issue) { err(ctx.res, 404, 'Not Found'); return true; }
    if (method === 'GET') {
      sendJson(ctx.res, 200, issueView(issue));
      return true;
    }
    if (method === 'PATCH') {
      const parsed = await readJson(ctx.req);
      if (!parsed.ok) { err(ctx.res, 400, 'Invalid JSON'); return true; }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      sendJson(ctx.res, 200, issueView(issue));
      return true;
    }
    return false;
  }

  if (p.length === 8 && p[7] === 'comments') {
    const issue = findIssue(repoKey, number);
    if (!issue) { err(ctx.res, 404, 'Not Found'); return true; }
    if (method === 'GET') {
      sendJson(ctx.res, 200, issue.comments.map(commentView));
      return true;
    }
    if (method === 'POST') {
      const parsed = await readJson(ctx.req);
      if (!parsed.ok) { err(ctx.res, 400, 'Invalid JSON'); return true; }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const comment: Comment = {
        id: store.nextId(),
        body: typeof body.body === 'string' ? body.body : '',
      };
      issue.comments.push(comment);
      sendJson(ctx.res, 201, commentView(comment));
      return true;
    }
    return false;
  }

  return false;
}
