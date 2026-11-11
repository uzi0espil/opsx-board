import { describe, expect, test } from 'claude-code/testing'

import { closingRefs, ghError, repoOfUrl } from '../hooks/github'
import { planItems } from '../hooks/providers'
import { issueFromBranch, issueMark, issueRefs } from '../hooks/providers/github'
import { readHints } from '../hooks/schema'
import { GITHUB_PRS, GITHUB_PROPOSAL_MD } from './fixtures'

describe('GitHub issues', () => {
  test('the issue references of a line, in their order and each once', async () => {
    expect(issueRefs('- #12 CSV export, see o/r#5, https://github.com/other/lib/issues/7 and #12 again')).toEqual([
      { number: 12 },
      { repo: 'o/r', number: 5 },
      { repo: 'other/lib', number: 7 },
    ])
    // A heading, a word, a path, an anchor, an HTML entity, and a pull request URL name no issue.
    for (const text of ['## 12. Group', 'a#12', 'docs/a/b#3', '[notes](#13-notes)', '&#123;', 'https://github.com/o/r/pull/9', '#0']) {
      expect(issueRefs(text)).toEqual([])
    }
    // Neither does a number after "PR" or "pull request".
    expect(issueRefs('PR #85, PR#86, PRs #3, pull request #226, operator pull request o/r#10, MR !4 and merge request #5; closes #12')).toEqual([
      { number: 12 },
    ])
  })

  test('the issue a branch name holds, by the branch pattern', async () => {
    expect(issueFromBranch('34-csv-export', '^(\\d+)-')).toBe(34)
    expect(issueFromBranch('feature/34-csv', '^(?:\\w+/)?(\\d+)-')).toBe(34)
    expect(issueFromBranch('main', '^(\\d+)-')).toBeUndefined()
    expect(issueFromBranch('0-nothing', '^(\\d+)-')).toBeUndefined()
    expect(issueFromBranch('34-csv-export', undefined)).toBeUndefined()
  })

  test('the issues of the proposal section, with the text beside each as its first title', async () => {
    const hints = { label: 'Issues', section: 'Issues', isBeforeExplore: false, refs: [{ provider: 'github' as const, isPrClosing: true }] }
    expect(planItems(GITHUB_PROPOSAL_MD, hints).items).toEqual([
      { id: '#12', title: 'CSV export', provider: 'github', via: 'proposal', issue: { number: 12 } },
      { id: 'other/lib#7', title: 'Needs the upstream fix', provider: 'github', via: 'proposal', issue: { repo: 'other/lib', number: 7 } },
    ])
    // Without a GitHub ref, the same section names no work item.
    expect(planItems(GITHUB_PROPOSAL_MD, { ...hints, refs: [] }).items).toEqual([])
  })

  test('what gh gives: the issues a pull request closes, an issue state, and an error', async () => {
    const [pr] = JSON.parse(GITHUB_PRS) as { closingIssuesReferences: unknown }[]
    expect(closingRefs(pr?.closingIssuesReferences)).toEqual([
      { repo: 'o/r', number: 12 },
      { repo: 'o/r', number: 40 },
    ])
    expect(closingRefs([{ number: 3, repository: { name: '..', owner: { login: 'x' } } }, { number: 'x' }, null])).toEqual([])
    const info = { title: 't', url: 'u' }
    expect(issueMark({ ...info, state: 'OPEN' })).toBe(' ')
    expect(issueMark({ ...info, state: 'CLOSED', stateReason: 'COMPLETED' })).toBe('x')
    expect(issueMark({ ...info, state: 'CLOSED', stateReason: 'NOT_PLANNED' })).toBe('-')
    expect(issueMark({ ...info, state: 'MERGED' })).toBe('x')
    expect(ghError('To get started with GitHub CLI, please run:  gh auth login')).toBe('gh is not logged in: run gh auth login')
    expect(ghError('GraphQL: Could not resolve to an issue or pull request with the number of 7.')).toBe('not found')
    expect(ghError('none of the git remotes configured for this repository point to a known GitHub host')).toBe(
      'gh finds no GitHub repository here: name one with repo in board.yaml',
    )
    expect(ghError('HTTP 502: Bad Gateway\nmore')).toBe('gh: HTTP 502: Bad Gateway')
    expect(repoOfUrl('https://github.com/o/r/pull/51')).toBe('o/r')
    expect(repoOfUrl('https://example.com/o/r/pull/51')).toBeUndefined()
  })

  test('a github reference in board.yaml: a repository, a branch pattern, and the pull request flag', async () => {
    const hints = readHints(
      'spec-driven',
      `version: 1
stages:
  - { id: plan, label: Issues, collects: work-item, section: Issues }
refs:
  - { kind: work-item, provider: github, repo: o/r, branch: '^(\\d+)-', pr: false }
  - { kind: work-item, provider: github }
  - { kind: design, provider: github, pattern: 'x' }
`,
      '/home/me/board.yaml',
    )
    expect(hints.plan?.refs).toEqual([{ provider: 'github', repo: 'o/r', branch: '^(\\d+)-', isPrClosing: false }])
    expect(hints.warnings).toEqual(['refs[1]: only the first github reference counts', 'refs[2]: provider "github" gives work items only'])

    // A repository that is not owner/name never reaches gh -R.
    const bad = readHints('spec-driven', `stages: [{ collects: work-item, section: Issues }]\nrefs: [{ kind: work-item, provider: github, repo: 'o/r -R x', pr: yes }]\n`, '/b.yaml')
    expect(bad.plan?.refs).toEqual([])
    expect(bad.warnings).toEqual(['refs[0]: repo "o/r -R x" is not owner/name'])
  })
})
