/**
 * Deploying an idea's Builder agent. Deploy is cheap and idempotent in
 * effect (each deploy registers a fresh version of the same agent), so
 * kaka re-deploys before every run — the agent's identity always carries
 * the CURRENT idea text.
 */

import type { AgentDeployRecord, OnCellClient } from '@platform/oncell'
import { buildBuilderManifest, builderAgentName } from './agent-def'
import { builderAgentSource } from './source'

/** Deploys (or re-deploys) the Builder for an idea. */
export async function deployBuilderAgent(
  oncell: OnCellClient,
  ideaName: string,
  ideaText: string
): Promise<AgentDeployRecord> {
  return oncell.deployAgent({
    name: builderAgentName(ideaName),
    source: builderAgentSource(ideaName, ideaText),
    manifest: buildBuilderManifest(ideaName, ideaText)
  })
}
