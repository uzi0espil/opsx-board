import { describe, expect, test } from 'claude-code/testing'

import { artifactLevels, inRequiresOrder, isSafePath, readHints, readSchema, schemaNameOf } from '../hooks/schema'
import { parseYaml } from '../hooks/yaml'
import { OPENSPEC_YAML, DEMO_BOARD_YAML, GATED_SCHEMA_YAML, TEAM_SCHEMA_YAML } from './fixtures'

describe('yaml', () => {
  test('block and flow collections, scalars, and comments', async () => {
    const doc = parseYaml(`# a comment
name: demo   # trailing comment
count: 3
ratio: 0.5
on: true
empty:
list:
  - a
  - 'b # not a comment'
  - "c\\td"
compact:
- x
- y
flow: [ one, two , 'th,ree' ]
map: { id: plan, label: "Plan", nested: [a, { b: c }] }
items:
  - id: first
    requires: [a]
  - id: second
    requires:
      - first
url: http://example.com/a:b
`)
    expect(doc).toEqual({
      name: 'demo',
      count: 3,
      ratio: 0.5,
      on: true,
      empty: null,
      list: ['a', 'b # not a comment', 'c\td'],
      compact: ['x', 'y'],
      flow: ['one', 'two', 'th,ree'],
      map: { id: 'plan', label: 'Plan', nested: ['a', { b: 'c' }] },
      items: [
        { id: 'first', requires: ['a'] },
        { id: 'second', requires: ['first'] },
      ],
      url: 'http://example.com/a:b',
    })
  })

  test('block scalars keep their text, and a flow collection may span lines', async () => {
    const doc = parseYaml(`literal: |
  line one
    indented
  - not a list

folded: >
  one
  two

  three
strip: |-
  x
links: [{ pattern: 'WI-\\d+', file: docs/a.md },
        { pattern: 'BUG-\\d+', file: docs/b.md }]
plain: a long value
  that goes on
`)
    expect(doc).toEqual({
      literal: 'line one\n  indented\n- not a list\n',
      folded: 'one two\nthree\n',
      strip: 'x',
      links: [
        { pattern: 'WI-\\d+', file: 'docs/a.md' },
        { pattern: 'BUG-\\d+', file: 'docs/b.md' },
      ],
      plain: 'a long value that goes on',
    })
  })

  test('a line it cannot read names its line', async () => {
    expect(() => parseYaml('a: 1\n   b: 2\n')).toThrow(/line 2/)
    expect(() => parseYaml('a: [1, 2\n')).toThrow()
    expect(() => parseYaml('a: &anchor 1\n')).toThrow(/anchors/)
    expect(() => parseYaml('a: "bad \\q escape"\n')).toThrow(/escape/)
  })
})

describe('schema', () => {
  test('the artifacts of a schema.yaml, in either requires form', async () => {
    const gated = readSchema(GATED_SCHEMA_YAML)
    expect(gated?.name).toBe('gated-spec-driven')
    expect(gated?.artifacts).toEqual([
      { id: 'proposal', generates: 'proposal.md', requires: [] },
      { id: 'arch-review', generates: 'arch-review.md', requires: ['proposal'] },
      { id: 'specs', generates: 'specs/**/*.md', requires: ['proposal', 'arch-review'] },
      { id: 'design', generates: 'design.md', requires: ['proposal', 'arch-review'] },
      { id: 'tasks', generates: 'tasks.md', requires: ['specs', 'design'] },
    ])
    expect(gated?.applyRequires).toEqual(['tasks'])
    expect(gated?.tracks).toBe('tasks.md')
    const team = readSchema(TEAM_SCHEMA_YAML)
    expect(team?.artifacts.map(artifact => artifact.id)).toEqual(['proposal', 'research', 'specs', 'design', 'tasks'])
    expect(team?.artifacts[2]).toEqual({ id: 'specs', generates: 'specs/**/*.md', requires: ['research'] })
  })

  test('requires order: levels, siblings side by side, and a cycle', async () => {
    const team = readSchema(TEAM_SCHEMA_YAML)?.artifacts ?? []
    expect(Object.fromEntries(artifactLevels(team))).toEqual({ proposal: 0, research: 1, specs: 2, design: 2, tasks: 3 })
    // Declared out of order: each artifact comes after what it requires.
    const shuffled = [team[4], team[2], team[0], team[3], team[1]].filter(row => row !== undefined)
    expect(inRequiresOrder(shuffled).map(row => `${row.id}:${row.level}`)).toEqual([
      'proposal:0',
      'research:1',
      'specs:2',
      'design:2',
      'tasks:3',
    ])
    expect(Object.fromEntries(artifactLevels([{ id: 'a', requires: ['b'] }, { id: 'b', requires: ['a'] }]))).toEqual({ a: 1, b: 0 })
  })

  test('the schema an .openspec.yaml names', async () => {
    expect(schemaNameOf(OPENSPEC_YAML)).toBe('gated-spec-driven')
    expect(schemaNameOf("schema: 'team-flow' # ours\n")).toBe('team-flow')
    expect(schemaNameOf('schema: ../../etc\n')).toBeUndefined()
    expect(schemaNameOf('created: 2026-10-22\n')).toBeUndefined()
  })
})

describe('board.yaml', () => {
  test('the hints of the demo project', async () => {
    const hints = readHints('gated-spec-driven', DEMO_BOARD_YAML, '/repo/board.yaml')
    expect(hints.warnings).toEqual([])
    expect(hints.plan).toEqual({
      label: 'Plan',
      section: 'Planning Items|Backlog Items',
      agent: 'planner',
      isBeforeExplore: true,
      refs: [
        { provider: 'file', pattern: 'WI-\\d+', file: 'docs/backlog.md', history: undefined },
        { provider: 'file', pattern: 'BUG-\\d+', file: 'docs/bugs.md', history: 'docs/bugs-closed.md' },
      ],
    })
    expect(hints.design).toMatchObject({
      label: 'Design',
      command: 'designer',
      skipArgs: ['component'],
      nextNew: '/designer {id}',
      nextUpdate: '/designer update {id}',
      dir: 'designs/{id}',
      open: 'artifact.html',
      decisions: 'decisions.md',
    })
    expect(hints.verdicts['arch-review']).toMatchObject({ block: ['BLOCK'], warn: ['REQUIRES-ADR'], next: '/opsx:update {change}' })
    expect(hints.verifyLabel).toBe('Review')
    expect(hints.reviewAgent).toBe('spec-reviewer')
    expect(hints.skipReportAgents).toEqual(['architect'])
  })

  test('a repository cannot make the board leave the repository, run a program, or call another provider', async () => {
    const hints = readHints(
      'evil',
      `version: 1
stages:
  - { id: plan, collects: work-item, section: Plan }
  - { id: design, collects: design, section: Design, next: { new: '/x {id}; rm -rf /' } }
refs:
  - { kind: work-item, provider: file, pattern: 'X-\\d+', file: ../../outside.md }
  - { kind: work-item, provider: file, pattern: 'Y-\\d+', file: C:/Windows/win.ini }
  - { kind: work-item, provider: file, pattern: '(', file: docs/a.md }
  - { kind: work-item, provider: mcp, tool: createJiraIssue, pattern: 'Z-\\d+' }
  - { kind: design, provider: file, pattern: 'designs/(\\w+)/', dir: 'designs/{id}', open: run.bat }
commits:
  task: '${'a'.repeat(400)}'
`,
      '/repo/board.yaml',
    )
    expect(hints.plan?.refs).toEqual([])
    expect(hints.design?.open).toBeUndefined()
    expect(hints.design?.nextNew).toBeUndefined()
    expect(hints.commits.task).toBeUndefined()
    expect(hints.warnings).toEqual([
      'refs[0]: "../../outside.md" is not a path inside the repository',
      'refs[0]: a work-item reference needs a pattern and a file',
      'refs[1]: "C:/Windows/win.ini" is not a path inside the repository',
      'refs[1]: a work-item reference needs a pattern and a file',
      'refs[2]: the pattern does not compile or is longer than 300 characters',
      'refs[3]: provider "mcp" is not built in yet',
      'refs[4]: open must name a document file in the design folder, such as artifact.html',
      'stages[1].next.new: "/x {id}; rm -rf /" is not a slash command with a short argument',
      'commits.task: the pattern does not compile or is longer than 300 characters',
    ])
    expect(isSafePath('docs/backlog.md')).toBe(true)
    expect(isSafePath('designs/{id}')).toBe(true)
    for (const path of ['/etc/passwd', '..', 'a/../b', 'a\\b', 'C:x', './a', 'a//b', '']) {
      expect(isSafePath(path)).toBe(false)
    }
  })

  test('a file the reader refuses gives no hints and one warning', async () => {
    const hints = readHints('broken', 'stages: [\n', '/repo/board.yaml')
    expect(hints.plan).toBeUndefined()
    expect(hints.warnings).toHaveLength(1)
    expect(hints.warnings[0]).toMatch(/^board\.yaml line \d+/)
  })
})
