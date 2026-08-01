import { describe, expect, test } from 'vitest'
import {
  AUTO_KEY,
  buildBuilderManifest,
  builderAgentName,
  builderIdentityInstructions,
  IMPROVE_SKILL_DESCRIPTION,
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

  test('remembers the cell id in memory for self-scheduled wakes', () => {
    // Act
    const source = builderAgentSource('acme', 'sell anvils')

    // Assert
    expect(source).toContain('kaka:cell_id')
    expect(source).toContain('agent.memory.set(CELL_ID_MEMORY_KEY')
    expect(source).toContain('agent.memory.get(CELL_ID_MEMORY_KEY')
  })
})
