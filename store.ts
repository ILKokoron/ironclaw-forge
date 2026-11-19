// Shared in-memory store. Deterministic: counters only, no wall-clock, no random.
// Every handler imports this single instance so REST / GraphQL / MCP / git see the same state.

export interface Repo {
  name: string; owner: string; private: boolean; description: string;
  default_branch: string; full_name: string; id: number;
  branches: Set<string>; refs: Map<string, string>; // refName -> commitSha
  commits: Map<string, CommitObj>; files: Map<string, FileObj>;
  gitObjects: Map<string, Buffer>; // oid -> raw loose object buffer (type+body)
}
export interface CommitObj { sha: string; message: string; tree: string; parents: string[]; }
export interface FileObj { path: string; content: string; sha: string; commitSha: string; }
export interface Issue {
  number: number; title: string; body: string; state: 'open'|'closed';
  labels: string[]; id: number; comments: Comment[];
}
export interface Comment { id: number; body: string; }
export interface Pull {
  number: number; title: string; body: string; state: 'open'|'closed';
  headRefName: string; baseRefName: string; headSha: string; baseSha: string;
  mergeable_state: string; merged: boolean; id: number; files: {filename:string; status:string}[];
}

class Store {
  repos = new Map<string, Repo>();       // key: `${owner}/${name}`
  issues = new Map<string, Issue[]>();   // key: repoKey
  pulls = new Map<string, Pull[]>();     // key: repoKey
  seqRepo = 0; seqIssue = 0; seqPull = 0; seqComment = 0; seqGlobal = 0;
  token = '';
  owner = '';

  repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
  getRepo(owner: string, name: string): Repo | undefined { return this.repos.get(this.repoKey(owner, name)); }
  nextId(): number { this.seqGlobal += 1; return this.seqGlobal; }
  nextIssue(repoKey: string): number { const a=this.issues.get(repoKey) ?? []; this.seqIssue+=1; return this.seqIssue; }
  nextPull(repoKey: string): number { const a=this.pulls.get(repoKey) ?? []; this.seqPull+=1; return this.seqPull; }
  issuesOf(repoKey: string): Issue[] { let a=this.issues.get(repoKey); if(!a){a=[];this.issues.set(repoKey,a);} return a; }
  pullsOf(repoKey: string): Pull[] { let a=this.pulls.get(repoKey); if(!a){a=[];this.pulls.set(repoKey,a);} return a; }
}

export const store = new Store();

// Global node id encoding (stable, deterministic).
export function gid(type: string, id: number): string {
  return Buffer.from(`${type}:${id}`).toString('base64url');
}
