import { describe, expect, test } from 'vitest'
import {
  APP_LOG_PATH,
  AUTO_KEY,
  buildBuilderManifest,
  builderAgentName,
  builderIdentityInstructions,
  founderDirectionBlock,
  IDEA_FILE_PATH,
  IMPROVE_SKILL_DESCRIPTION,
  improveSkillInstructions,
  ITERATIONS_KEY,
  PROGRESS_KEY,
  runBriefingTemplate
} from '@/lib/builder-agent/agent-def'
import { builderAgentSource } from '@/lib/builder-agent/source'

/**
 * The Builder agent definition: manifest wire shape, identity content, the
 * briefing protocol, and the generated deployable source.
 */

describe('builder agent definition', () => {
  test('names the agent builder-{idea}', () => {
    expect(builderAgentName('acme')).toBe('builder-acme')
  })

  test('manifest carries identity, capabilities, and the improve skill', () => {
    // Act
    const manifest = buildBuilderManifest('acme', 'sell anvils online')

    // Assert — exactly the identity/capabilities/skills wire contract.
    expect(manifest.identity.model).toBe('claude-sonnet-5')
    expect(manifest.identity.budgets).toEqual({ perDayCents: 500 })
    expect(manifest.identity.instructions).toContain('"acme"')
    expect(manifest.identity.instructions).toContain('sell anvils online')
    expect(manifest.capabilities).toEqual(['memory', 'cells', 'schedule'])
    expect(manifest.skills).toHaveLength(1)
    expect(manifest.skills[0]).toMatchObject({
      name: 'improve',
      description: IMPROVE_SKILL_DESCRIPTION,
      tools: ['cells', 'schedule']
    })
    expect(manifest.skills[0]?.description.length).toBeLessThanOrEqual(200)
  })

  test('identity embeds the app contract and the kv record-keeping protocol', () => {
    // Act
    const identity = builderIdentityInstructions('acme', 'sell anvils online')

    // Assert
    expect(identity).toContain('src/server.js')
    expect(identity).toContain('src/check.js')
    expect(identity).toContain('127.0.0.1')
    expect(identity).toContain(PROGRESS_KEY)
    expect(identity).toContain(ITERATIONS_KEY)
    expect(identity).toContain(AUTO_KEY)
  })

  test('briefing template covers stages, snapshot key, schedule, and the run token', () => {
    // Act
    const briefing = runBriefingTemplate()

    // Assert
    expect(briefing).toContain('{{KIND}}')
    expect(briefing).toContain('{{CELL_ID}}')
    expect(briefing).toContain('{{RUN}}')
    expect(briefing).toContain('{{SNAPSHOT_KEY}}')
    expect(briefing).toContain('{{AUTO_PREAMBLE}}')
    expect(briefing).toContain('cells_service_start')
    expect(briefing).toContain('"in":"30 minutes"')
    expect(briefing).toContain('"stage":"done"')
    expect(briefing).toContain('"stage":"error"')
  })

  test('briefing carries the direction block and points improve runs at the evidence protocol', () => {
    // Act
    const briefing = runBriefingTemplate()

    // Assert
    expect(briefing).toContain('{{DIRECTION_BLOCK}}')
    expect(briefing).toContain('evidence protocol')
    expect(briefing).toContain('a founder directive above IS that improvement')
  })

  test('founder direction block makes the directive the single improvement', () => {
    // Act
    const block = founderDirectionBlock()

    // Assert
    expect(block).toContain('The founder has directed this revision: {{DIRECTION}}')
    expect(block).toContain('IS the single improvement to ship this run')
    expect(block).toContain('do not substitute your own pick')
    expect(block).toContain('still verify with the self-test')
  })

  test('improve skill demands evidence before the pick, with runtime errors outranking features', () => {
    // Act
    const skill = improveSkillInstructions()

    // Assert — the three evidence sources, all reachable with granted tools.
    expect(skill).toContain(`cells_read_file "${IDEA_FILE_PATH}"`)
    expect(skill).toContain(ITERATIONS_KEY)
    expect(skill).toContain(`tail -n 200 ${APP_LOG_PATH}`)
    // Priority and attribution.
    expect(skill).toContain('runtime errors OUTRANK new features')
    expect(skill).toContain('(seen in logs)')
  })

  test('identity requires the app to keep the runtime self-log', () => {
    // Act
    const identity = builderIdentityInstructions('acme', 'sell anvils online')

    // Assert
    expect(identity).toContain(`self-log at "${APP_LOG_PATH}"`)
    expect(identity).toContain('runtime evidence')
  })
})

describe('builderAgentSource', () => {
  test('default-exports the identity-form Agent with build and improve tasks', () => {
    // Act
    const source = builderAgentSource('acme', 'sell anvils online')

    // Assert
    expect(source).toContain('import { Agent, tools, skill } from "oncell"')
    expect(source).toContain('new Agent("builder-acme"')
    expect(source).toContain('capabilities: [tools.memory, tools.cells, tools.schedule]')
    expect(source).toContain('agent.task("build"')
    expect(source).toContain('agent.task("improve"')
    expect(source).toContain('export default agent')
  })

  test('escapes idea text safely into string literals', () => {
    // Arrange — idea text with quotes, backticks, and newlines.
    const tricky = 'sell "anvils" with `speed`\nand ${style}'

    // Act
    const source = builderAgentSource('acme', tricky)

    // Assert — the JSON-escaped text is embedded, and the file stays valid JS
    // (no raw newline inside a string literal: JSON.stringify escapes it).
    expect(source).toContain(JSON.stringify(tricky).slice(1, -1))
  })

  test('substitutes the founder direction into the briefing per run', () => {
    // Act
    const source = builderAgentSource('acme', 'sell anvils')

    // Assert — the task code reads args.direction and fills the block only
    // when a direction is present.
    expect(source).toContain('args.direction')
    expect(source).toContain('DIRECTION_TEMPLATE')
    expect(source).toContain('"{{DIRECTION_BLOCK}}"')
    expect(source).toContain('"{{DIRECTION}}"')
  })

  test('remembers the cell id in memory for self-scheduled wakes', () => {
    // Act
    const source = builderAgentSource('acme', 'sell anvils')

    // Assert
    expect(source).toContain('kaka:cell_id')
    expect(source).toContain('agent.memory.set(CELL_ID_MEMORY_KEY')
    expect(source).toContain('agent.memory.get(CELL_ID_MEMORY_KEY')
  })
})
