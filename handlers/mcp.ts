// MCP handler: JSON-RPC 2.0 over Streamable HTTP at /mcp.
// Stateless: every request is answered from its own body + the shared store, so
// concurrent calls keep their own ids and never share per-request state.
import type { Ctx } from '../app.ts';
import { store, type Repo, type Issue, type Pull } from '../store.ts';
import { sendJson, readBody } from '../http.ts';

const SERVER_INFO = Object.freeze({ name: 'forge', version: '1.0.0' });
const CAPABILITIES = Object.freeze({ tools: Object.freeze({}) });
const PREFERRED_REVISION = '2026-07-28';
const SUPPORTED_VERSIONS = Object.freeze([
  '2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05',
]);

type JsonRpcId = string | number | null;
type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

// ------------------------------------------------------------------ json-rpc envelopes
function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function rpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
function idOf(value: unknown): JsonRpcId {
  if (typeof value === 'string' || typeof value === 'number') return value;
  return null;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ------------------------------------------------------------------ tool catalogue (constant -> byte-identical tools/list)
type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };
const strProp = (description: string) => ({ type: 'string', description });
const TOOLS: readonly Tool[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository in the authenticated user account.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Account that will own the repository.'),
        name: strProp('Name of the repository to create.'),
        description: strProp('Short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner login and repository name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Account that owns the repository.'),
        repo: strProp('Name of the repository.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Account that owns the repository.'),
        repo: strProp('Name of the repository.'),
        title: strProp('Title of the issue.'),
        body: strProp('Body text of the issue.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Account that owns the repository.'),
        repo: strProp('Name of the repository.'),
        state: strProp('Filter by state: open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Account that owns the repository.'),
        repo: strProp('Name of the repository.'),
        title: strProp('Title of the pull request.'),
        body: strProp('Body text of the pull request.'),
        head: strProp('Head branch containing the changes.'),
        base: strProp('Base branch to merge into.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Account that owns the repository.'),
        repo: strProp('Name of the repository.'),
        pull_number: { type: 'number', description: 'Number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

// ------------------------------------------------------------------ result helpers
function okResult(value: unknown): ToolResult {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}
function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
function missingResult(fields: string[]): ToolResult {
  return errorResult(`Missing required arguments: ${fields.join(', ')}`);
}
function str(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}
function ownerOf(args: Record<string, unknown>): string {
  return str(args.owner) || store.owner || 'octocat';
}

// ------------------------------------------------------------------ REST-parity views (same stored objects)
function viewRepo(r: Repo): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    full_name: r.full_name,
    owner: { login: r.owner },
    private: r.private,
    description: r.description,
    default_branch: r.default_branch,
    html_url: `https://github.com/${r.full_name}`,
  };
}
function viewIssue(owner: string, repo: string, i: Issue): Record<string, unknown> {
  return {
    id: i.id,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels,
    comments: i.comments,
    html_url: `https://github.com/${owner}/${repo}/issues/${i.number}`,
  };
}
function viewPull(owner: string, repo: string, p: Pull): Record<string, unknown> {
  return {
    id: p.id,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    merged: p.merged,
    mergeable_state: p.mergeable_state,
    head: { ref: p.headRefName, sha: p.headSha, label: `${owner}:${p.headRefName}` },
    base: { ref: p.baseRefName, sha: p.baseSha, label: `${owner}:${p.baseRefName}` },
    files: p.files,
    html_url: `https://github.com/${owner}/${repo}/pull/${p.number}`,
  };
}

// ------------------------------------------------------------------ tool execution
/** Execute a tool; null means "unknown tool" (the caller turns that into JSON-RPC -32602). */
async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name);
      if (repoName === '') return missingResult(['name']);
      const owner = ownerOf(args);
      const key = store.repoKey(owner, repoName);
      let repo = store.getRepo(owner, repoName);
      if (!repo) {
        repo = {
          name: repoName,
          owner,
          private: args.private === true,
          description: str(args.description),
          default_branch: 'main',
          full_name: `${owner}/${repoName}`,
          id: store.nextId(),
          branches: new Set<string>(['main']),
          refs: new Map<string, string>(),
          commits: new Map(),
          files: new Map(),
          gitObjects: new Map<string, Buffer>(),
        };
        store.repos.set(key, repo);
      }
      return okResult(viewRepo(repo));
    }
    case 'get_repo': {
      const repoName = str(args.repo);
      if (repoName === '') return missingResult(['repo']);
      const owner = ownerOf(args);
      const repo = store.getRepo(owner, repoName);
      if (repo) return okResult(viewRepo(repo));
      // A read of a repo the REST surface may not have materialised still names it.
      return okResult({
        id: 0, name: repoName, full_name: `${owner}/${repoName}`,
        owner: { login: owner }, default_branch: 'main', private: false, description: '',
      });
    }
    case 'create_issue': {
      const owner = ownerOf(args);
      const repo = str(args.repo);
      const title = str(args.title);
      const missing: string[] = [];
      if (repo === '') missing.push('repo');
      if (title === '') missing.push('title');
      if (missing.length > 0) return missingResult(missing);
      const key = store.repoKey(owner, repo);
      const number = store.nextIssue(key);
      const issue: Issue = {
        number,
        title,
        body: str(args.body),
        state: 'open',
        labels: [],
        id: store.nextId(),
        comments: [],
      };
      store.issuesOf(key).push(issue);
      return okResult(viewIssue(owner, repo, issue));
    }
    case 'list_issues': {
      const owner = ownerOf(args);
      const repo = str(args.repo);
      if (repo === '') return missingResult(['repo']);
      const key = store.repoKey(owner, repo);
      const issues = [...store.issuesOf(key)].sort((a, b) => a.number - b.number);
      return okResult(issues.map((i) => viewIssue(owner, repo, i)));
    }
    case 'create_pull_request': {
      const owner = ownerOf(args);
      const repo = str(args.repo);
      const title = str(args.title);
      const head = str(args.head);
      const base = str(args.base);
      const missing: string[] = [];
      if (repo === '') missing.push('repo');
      if (title === '') missing.push('title');
      if (head === '') missing.push('head');
      if (base === '') missing.push('base');
      if (missing.length > 0) return missingResult(missing);
      const key = store.repoKey(owner, repo);
      const number = store.nextPull(key);
      const r = store.getRepo(owner, repo);
      const shaFor = (ref: string): string => (r ? (r.refs.get(ref) ?? r.refs.get(`refs/heads/${ref}`) ?? '') : '');
      const pull: Pull = {
        number,
        title,
        body: str(args.body),
        state: 'open',
        headRefName: head,
        baseRefName: base,
        headSha: shaFor(head),
        baseSha: shaFor(base),
        mergeable_state: 'clean',
        merged: false,
        id: store.nextId(),
        files: [],
      };
      store.pullsOf(key).push(pull);
      return okResult(viewPull(owner, repo, pull));
    }
    case 'merge_pull_request': {
      const owner = ownerOf(args);
      const repo = str(args.repo);
      const raw = args.pull_number;
      let n = NaN;
      if (typeof raw === 'number' && Number.isFinite(raw)) n = Math.trunc(raw);
      else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) n = Number(raw.trim());
      const missing: string[] = [];
      if (repo === '') missing.push('repo');
      if (!Number.isFinite(n)) missing.push('pull_number');
      if (missing.length > 0) return missingResult(missing);
      const key = store.repoKey(owner, repo);
      const pull = store.pullsOf(key).find((p) => p.number === n);
      if (!pull) return errorResult(`Pull request #${n} not found`);
      pull.merged = true;
      pull.state = 'closed';
      return okResult({ ...viewPull(owner, repo, pull), merged: true, number: n });
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------------ auth
function authorized(ctx: Ctx): boolean {
  const header = ctx.req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return false;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  if (!match) return false;
  const supplied = match[1]!.trim();
  if (store.token && store.token !== '') return supplied === store.token;
  return supplied.length > 0;
}

// ------------------------------------------------------------------ entry point
export async function handleMcp(ctx: Ctx): Promise<boolean> {
  if (ctx.path !== '/mcp') return false;

  if (ctx.method === 'GET') {
    sendJson(ctx.res, 200, rpcResult(null, { ...SERVER_INFO, capabilities: CAPABILITIES }));
    return true;
  }
  if (ctx.method !== 'POST') {
    // e.g. the best-effort legacy session DELETE: acknowledge, hold nothing.
    sendJson(ctx.res, 200, rpcResult(null, {}));
    return true;
  }

  let raw: string;
  try {
    raw = (await readBody(ctx.req)).toString('utf8');
  } catch {
    sendJson(ctx.res, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }

  let msg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error('not a JSON-RPC object');
    msg = parsed;
  } catch {
    sendJson(ctx.res, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }

  const id = idOf(msg.id);
  const method = typeof msg.method === 'string' ? msg.method : '';
  if (method === '') {
    sendJson(ctx.res, 200, rpcError(id, -32600, 'Invalid Request'));
    return true;
  }

  try {
    if (method.startsWith('notifications/')) {
      sendJson(ctx.res, 202, rpcResult(id, {}));
      return true;
    }

    if (method === 'server/discover') {
      sendJson(ctx.res, 200, rpcResult(id, {
        resultType: 'discover',
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions: 'GitHub-compatible forge MCP server',
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      }));
      return true;
    }

    if (method === 'initialize') {
      let version = PREFERRED_REVISION;
      const params = msg.params;
      if (isRecord(params) && typeof params.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion)) {
        version = params.protocolVersion;
      }
      sendJson(ctx.res, 200, rpcResult(id, {
        protocolVersion: version,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
      }));
      return true;
    }

    if (method === 'tools/list') {
      sendJson(ctx.res, 200, rpcResult(id, { tools: TOOLS }));
      return true;
    }

    if (method === 'tools/call') {
      if (!authorized(ctx)) {
        sendJson(ctx.res, 401, rpcError(id, -32001, 'Unauthorized'));
        return true;
      }
      const params = isRecord(msg.params) ? msg.params : {};
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const result = await executeTool(name, args);
      if (result === null) {
        sendJson(ctx.res, 200, rpcError(id, -32602, `Unknown tool: ${name}`));
        return true;
      }
      sendJson(ctx.res, 200, rpcResult(id, result));
      return true;
    }

    sendJson(ctx.res, 200, rpcError(id, -32601, `Method not found: ${method}`));
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(ctx.res, 200, rpcError(id, -32603, `Internal error: ${message}`));
    return true;
  }
}
