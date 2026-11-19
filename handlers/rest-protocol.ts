// Cross-cutting REST protocol checks. The response-shape guarantees (x-github-request-id,
// application/json content-type, string `message` on 401/404/422) come from http.ts; every
// reply here still goes through a sendJson/sendRaw helper so the deterministic request-id
// counter advances exactly once per response.
//
// This module also owns the shared serialized-response cache used by the sibling REST
// handlers. Keys fold in a fingerprint of every input that can affect a JSON body, so a
// mutation from ANY handler (REST / GraphQL / MCP) automatically produces a new key.
import type { Ctx } from '../app.ts';
import { readBody, err, sendJson, sendRaw } from '../http.ts';

const JSON_CT = 'application/json; charset=utf-8';

// ---------------------------------------------------------------- response cache
const responseCache = new Map<string, string>();

/**
 * Send a JSON reply, serializing the body at most once per distinct cache key.
 * sendRaw stamps x-github-request-id (same counter as sendJson) and content-length;
 * we add the identical content-type header. No clock, no randomness: keys are pure
 * functions of request state and store contents.
 */
export function cachedJson(
  ctx: Ctx,
  status: number,
  key: string,
  build: () => unknown,
  headers: Record<string, string> = {},
): void {
  let text = responseCache.get(key);
  if (text === undefined) {
    text = `${JSON.stringify(build())}\n`;
    if (responseCache.size >= 4096) responseCache.clear();
    responseCache.set(key, text);
  }
  const out: Record<string, string> = { 'content-type': JSON_CT };
  for (const name in headers) out[name] = headers[name];
  sendRaw(ctx.res, status, text, out);
}

/** Drop every cached reply (used by mutations best handled by wholesale eviction). */
export function invalidateJsonCache(): void { responseCache.clear(); }

// ---------------------------------------------------------------- parse-once bodies
// The protocol pre-parser reads POST /user/repos to validate JSON. Stash the parsed
// value so the downstream REST handler does not read and parse the same body again.
const parsedBodies = new WeakMap<object, { ok: boolean; value: unknown }>();
export function stashParsed(req: object, parsed: { ok: boolean; value: unknown }): void {
  parsedBodies.set(req, parsed);
}
export function takeParsed(req: object): { ok: boolean; value: unknown } | undefined {
  const value = parsedBodies.get(req);
  if (value !== undefined) parsedBodies.delete(req);
  return value;
}

// ---------------------------------------------------------------- static /meta body
const META_BODY = {
  installed_version: '0.0.1',
  version: '0.0.1',
  sha: '0000000000000000000000000000000000000000',
  date: '2026-01-01T00:00:00Z',
  git_commit: '0000000000000000000000000000000000000000',
  current_user_url: '/api/v3/user',
};
// Serialized once at module load; the body is a compile-time constant.
const META_JSON = `${JSON.stringify(META_BODY)}\n`;

export async function handleProtocol(ctx: Ctx): Promise<boolean> {
  // GET /api/v3/meta — global server metadata, fully static. sendRaw still stamps
  // content-type + x-github-request-id on every reply.
  if (ctx.method === 'GET' && ctx.path === '/api/v3/meta') {
    sendRaw(ctx.res, 200, META_JSON, { 'content-type': JSON_CT });
    return true;
  }

  if (ctx.method !== 'POST' || ctx.path !== '/api/v3/user/repos') return false;

  // Read the raw body once, decide whether it is valid JSON, and remember the result.
  const body = await readBody(ctx.req);
  let parsed: { ok: boolean; value: unknown };
  try {
    parsed = { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    // err() stamps content-type + x-github-request-id and a string `message`.
    err(ctx.res, 400, 'Problems parsing JSON');
    return true;
  }
  stashParsed(ctx.req, parsed);

  // Valid JSON: this handler does not own the route. Restore the consumed body so the
  // downstream REST dispatcher (rest-repos) can read it via readJson() if it needs to.
  // readJson() iterates the request with `for await`, so shadowing the instance async
  // iterator replays our buffered bytes exactly once before ending.
  let replayed = false;
  (ctx.req as unknown as Record<PropertyKey, unknown>)[Symbol.asyncIterator] =
    async function* (): AsyncGenerator<Buffer> {
      if (!replayed) {
        replayed = true;
        yield body;
      }
    };

  return false;
}
