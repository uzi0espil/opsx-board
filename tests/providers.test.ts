import { describe, expect, test } from 'claude-code/testing'

import { planFiles, planItems, providerOf, readWorkItemRef } from '../hooks/providers'
import { clickupError, taskInfo, taskMark, taskRefs } from '../hooks/providers/clickup'
import type { PlanHints, WorkItemRef } from '../types'

const PLAN: PlanHints = {
  label: 'Plan',
  section: 'Planning Items',
  isBeforeExplore: false,
  refs: [
    { provider: 'file', pattern: 'WI-\\d+', file: 'docs/backlog.md', history: 'docs/backlog-done.md' },
    { provider: 'file', pattern: 'BUG-\\d+', file: 'docs/bugs.md' },
    { provider: 'github', isPrClosing: true },
  ],
}

describe('work-item providers', () => {
  test('a line belongs to the first provider that names an item in it, and an item shows once', async () => {
    const md = [
      '## Planning Items',
      '',
      '- [~] **WI-12 · CSV export** — see #12',
      '- #12 the export issue, and #12 again',
      '- [ ] **BUG-3 · Crash**',
      '- [ ] **WI-12 · CSV export** — named twice',
    ].join('\n')
    expect(planItems(md, PLAN).items.map(item => `${item.provider}:${item.id}`)).toEqual(['file:WI-12', 'github:#12', 'file:BUG-3'])
    // A provider without a ref names nothing.
    expect(planItems(md, { ...PLAN, refs: PLAN.refs.filter(ref => ref.provider !== 'github') }).items.map(item => item.id)).toEqual(['WI-12', 'BUG-3'])
  })

  test('board.yaml names a provider the board holds, and once when it allows one ref', async () => {
    const check = { warnings: [] as string[] }
    const before: WorkItemRef[] = [{ provider: 'github', isPrClosing: true }]
    expect(readWorkItemRef({ provider: 'jira', project: 'X' }, [], check, 'refs[0]')).toBeUndefined()
    expect(readWorkItemRef({ provider: 'github' }, before, check, 'refs[1]')).toBeUndefined()
    expect(readWorkItemRef({ pattern: 'WI-\\d+', file: 'docs/backlog.md' }, before, check, 'refs[2]')).toEqual({
      provider: 'file',
      pattern: 'WI-\\d+',
      file: 'docs/backlog.md',
      history: undefined,
    })
    expect(check.warnings).toEqual(['refs[0]: provider "jira" is not built in yet', 'refs[1]: only the first github reference counts'])
  })

  test('ClickUp tasks: the links of a list line, the mark of a status type, and what the CLI gives', async () => {
    expect(
      taskRefs('- [9aa1bb2cc](https://app.clickup.com/t/9aa1bb2cc), https://app.clickup.com/t/9015123/DEV-1234, again https://app.clickup.com/t/9aa1bb2cc'),
    ).toEqual(['9aa1bb2cc', 'DEV-1234'])
    expect(taskRefs('https://www.figma.com/design/abc and https://app.clickup.com/v/li/901518867446')).toEqual([])
    const plan: PlanHints = { label: 'ClickUp', section: 'References', isBeforeExplore: false, refs: [{ provider: 'clickup' }] }
    const md = '## References\n\n- **ClickUp Task:** [9aa1bb2cc](https://app.clickup.com/t/9aa1bb2cc)\nProse names https://app.clickup.com/t/9zz0zz0zz.\n'
    expect(planItems(md, plan).items).toEqual([
      { id: '9aa1bb2cc', title: 'ClickUp Task', provider: 'clickup', via: 'proposal', task: { url: 'https://app.clickup.com/t/9aa1bb2cc' } },
    ])
    expect(['open', 'custom', 'done', 'closed'].map(taskMark)).toEqual([' ', '~', 'x', 'x'])
    const json = { id: '9aa1bb2cc', name: 'Persist the label', status: { status: 'in review', type: 'custom' }, url: 'https://app.clickup.com/t/9aa1bb2cc' }
    expect(taskInfo(json)).toEqual({ ...json, status: 'in review', type: 'custom' })
    for (const odd of [null, [], { ...json, url: 'javascript:alert(1)' }, { ...json, status: 'done' }, { ...json, name: 7 }]) {
      expect(taskInfo(odd)).toBeUndefined()
    }
    expect(clickupError("authentication required. Run 'clickup auth login' to authenticate", 4)).toBe('clickup is not logged in: run clickup auth login')
    expect(clickupError('rate limited\nmore', 1)).toBe('clickup: rate limited')
    // board.yaml names one clickup ref, with an optional branch pattern.
    const check = { warnings: [] as string[] }
    expect(readWorkItemRef({ provider: 'clickup', branch: '^([0-9a-z]{9,13})_' }, [], check, 'refs[0]')).toEqual({ provider: 'clickup', branch: '^([0-9a-z]{9,13})_' })
    expect(readWorkItemRef({ provider: 'clickup' }, [{ provider: 'clickup' }], check, 'refs[1]')).toBeUndefined()
    expect(check.warnings).toEqual(['refs[1]: only the first clickup reference counts'])
  })

  test('the files whose edits change the items, and the provider of an item written before items named theirs', async () => {
    expect(planFiles(PLAN)).toEqual(['docs/backlog.md', 'docs/backlog-done.md', 'docs/bugs.md'])
    expect(planFiles(undefined)).toEqual([])
    expect(providerOf({ id: '#12', title: '', issue: { number: 12 } })).toBe('github')
    expect(providerOf({ id: 'WI-1', title: '', file: 'docs/backlog.md' })).toBe('file')
  })
})
