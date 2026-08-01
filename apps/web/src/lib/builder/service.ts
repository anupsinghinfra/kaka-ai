/**
 * App service lifecycle for built ideas. After a build/improve the cell's
 * service is (re)started with the contract entry point, and the live
 * preview URL — the payoff of the whole loop — is recorded on the idea.
 * Start failures are non-fatal: they are recorded as serviceError so the
 * UI can surface a retry.
 */

import { OnCellApiError, type OnCellClient } from '@platform/oncell'
import { updateIdea, type Idea } from '../registry'
import { REQUIRED_SERVER_PATH } from './contract'

/** The one way every generated app starts (enforced by the contract). */
export const APP_START_CMD = `node ${REQUIRED_SERVER_PATH}`

/** Domain serving cell preview URLs (https://{cell_id}.cells.oncell.ai). */
const PREVIEW_URL_DOMAIN = 'cells.oncell.ai'

export type ServiceStartOutcome =
  | { readonly ok: true; readonly liveUrl: string }
  | { readonly ok: false; readonly serviceError: string }

/** True for the errors DELETE /service returns when nothing is running. */
function isNothingRunning(error: unknown): boolean {
  return (
    error instanceof OnCellApiError && (error.code === 'NO_APP_RUNNING' || error.status === 404)
  )
}

/** The cell's preview URL: the API's value when present, else the documented shape. */
export async function resolvePreviewUrl(oncell: OnCellClient, cellId: string): Promise<string> {
  try {
    const cell = await oncell.getCell(cellId)
    const fromApi = cell?.preview_url
    if (typeof fromApi === 'string' && fromApi.length > 0) {
      return fromApi
    }
  } catch {
    // Best-effort — fall through to the documented URL shape.
  }
  return `https://${cellId}.${PREVIEW_URL_DOMAIN}`
}

/**
 * Stops any running app service (tolerating "nothing running"), starts the
 * contract entry point with PORT injected by OnCell, and records the
 * outcome on the idea: liveUrl on success (clearing serviceError), or
 * serviceError on failure (clearing liveUrl — the old service is gone).
 */
export async function restartAppService(
  oncell: OnCellClient,
  idea: Pick<Idea, 'name' | 'cellId'>
): Promise<ServiceStartOutcome> {
  try {
    try {
      await oncell.stopService(idea.cellId)
    } catch (error: unknown) {
      if (!isNothingRunning(error)) {
        throw error
      }
    }
    const service = await oncell.startService(idea.cellId, { cmd: APP_START_CMD })
    if (service !== undefined && service.running === false) {
      throw new Error('the app process did not stay running')
    }
    const liveUrl = await resolvePreviewUrl(oncell, idea.cellId)
    updateIdea(idea.name, { liveUrl, serviceError: undefined })
    return { ok: true, liveUrl }
  } catch (error: unknown) {
    const serviceError = error instanceof Error ? error.message : String(error)
    updateIdea(idea.name, { liveUrl: undefined, serviceError })
    return { ok: false, serviceError }
  }
}
