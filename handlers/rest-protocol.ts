// Cross-cutting REST protocol checks. This handler is intentionally narrow: the
// response-shape guarantees (x-github-request-id, application/json content-type,
// string `message` on 401/404/422) already come from http.ts's sendJson/err,
// which the dispatcher uses for every reply. The only request this module owns
// is the malformed-JSON body on POST /api/v3/user/repos, which must yield 400.
import type { Ctx } from '../app.ts';
import { readBody, err, sendJson } from '../http.ts';

export async function handleProtocol(ctx: Ctx): Promise<boolean> {
  // GET /api/v3/meta — global server metadata. sendJson stamps
  // content-type: application/json + x-github-request-id on every reply.
  if (ctx.method === 'GET' && ctx.path === '/api/v3/meta') {
    sendJson(ctx.res, 200, {
      installed_version: '0.0.1',
      version: '0.0.1',
      sha: '0000000000000000000000000000000000000000',
      date: '2026-01-01T00:00:00Z',
      git_commit: '0000000000000000000000000000000000000000',
      current_user_url: '/api/v3/user',
    });
    return true;
  }

  if (ctx.method !== 'POST' || ctx.path !== '/api/v3/user/repos') return false;

  // Read the raw body and decide whether it is valid JSON.
  const body = await readBody(ctx.req);
  try {
    JSON.parse(body.toString('utf8'));
  } catch {
    // err() stamps content-type: application/json + x-github-request-id and a
    // string `message`, satisfying every protocol expectation for this reply.
    err(ctx.res, 400, 'Problems parsing JSON');
    return true;
  }

  // Valid JSON: this handler does not own the route. Restore the consumed body
  // so the downstream REST dispatcher (rest-repos) can read it via readJson().
  // readJson() iterates the request with `for await`, so shadowing the instance
  // async iterator replays our buffered bytes exactly once before ending.
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
