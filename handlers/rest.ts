// REST v3 dispatcher. Sub-modules own one resource group each; first one that
// handles the request returns true. Order matters only for overlapping prefixes.
import type { Ctx } from '../app.ts';
import { handleRepos } from './rest-repos.ts';
import { handleIssues } from './rest-issues.ts';
import { handlePulls } from './rest-pulls.ts';
import { handleProtocol } from './rest-protocol.ts';

export async function handleRest(ctx: Ctx): Promise<boolean> {
  if (await handleProtocol(ctx)) return true;
  if (await handleRepos(ctx)) return true;
  if (await handleIssues(ctx)) return true;
  if (await handlePulls(ctx)) return true;
  return false;
}
