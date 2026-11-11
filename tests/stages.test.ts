import { describe, expect, test } from 'claude-code/testing'

import { readHints } from '../hooks/schema'
import { STAGES, flowOf, nextStep, stageKind, stagesOf } from '../hooks/stages'
import type { AgentRun, Live, Snapshot } from '../types'

const LIVE: Live = { designRuns: [] }

const snapshot = (fields: Partial<Snapshot>): Snapshot => ({
  change: 'csv-export',
  root: '/repo',
  dir: '/repo/openspec/changes/csv-export',
  specs: [],
  exists: true,
  artifacts: [],
  isPlanningComplete: false,
  specsCount: 0,
  groups: [],
  planning: [],
  designs: [],
  commits: [],
  refreshedAt: 0,
  warnings: [],
  ...fields,
})

const hintsWith = (plan: string) =>
  readHints(
    'spec-driven',
    `version: 1
stages:
  - { id: plan, collects: work-item, section: Plan${plan} }
  - { id: design, collects: design, section: Visual Design, command: designer }
refs:
  - { kind: design, provider: file, pattern: 'designs/(\\w+)/', dir: 'designs/{id}' }
`,
    '/repo/board.yaml',
  )

describe('stages', () => {
  test('each kind of stage once, and the flow in the order the hints give', async () => {
    expect(new Set(STAGES.map(kind => kind.key)).size).toBe(STAGES.length)
    expect(stageKind('apply')?.key).toBe('apply')
    // Plan and Design are stages only when the hints define them.
    expect(stagesOf(null, LIVE, [], 0).map(stage => stage.key)).toEqual(['explore', 'propose', 'apply', 'verify', 'pr', 'archive'])
    expect(stagesOf(null, LIVE, [], 0, [], hintsWith(', before: explore')).map(stage => stage.key)).toEqual([
      'plan',
      'explore',
      'design',
      'propose',
      'apply',
      'verify',
      'pr',
      'archive',
    ])
    expect(stagesOf(null, LIVE, [], 0, [], hintsWith('')).map(stage => stage.key).slice(0, 3)).toEqual(['explore', 'plan', 'design'])
  })

  test('Next offers the step of the first stage whose condition holds', async () => {
    const planning = snapshot({ artifacts: [{ id: 'proposal', status: 'done' }, { id: 'design', status: 'ready' }] })
    expect(nextStep(flowOf(planning, LIVE, [], 0))).toEqual({ text: '/opsx:continue csv-export', why: 'next: design' })
    expect(nextStep(flowOf(snapshot({ exists: false }), LIVE, [], 0))).toEqual({ text: '/opsx:propose csv-export', why: 'no change folder yet' })
  })

  test('no Next while the work of a stage runs, or for an archived change', async () => {
    const planning = snapshot({ artifacts: [{ id: 'proposal', status: 'ready' }] })
    const agent: AgentRun = {
      id: 'a1',
      type: 'general-purpose',
      description: 'Write the design',
      phase: 'propose',
      status: 'running',
      startedAt: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      isBackground: false,
    }
    expect(nextStep(flowOf(planning, LIVE, [agent], 0))).toBeUndefined()
    expect(nextStep(flowOf(snapshot({ archivedAs: '2026-11-11-csv-export', isPlanningComplete: true }), LIVE, [], 0))).toBeUndefined()
  })
})
