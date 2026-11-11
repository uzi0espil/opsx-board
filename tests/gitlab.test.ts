import { describe, expect, test } from 'claude-code/testing'

import { prWords } from '../hooks/hosts'
import { fromMergeRequest } from '../hooks/hosts/gitlab'

describe('GitLab merge requests', () => {
  const page = 'https://gitlab.example.com/o/r/-/merge_requests/12'

  test('a merge request of the API is a pull request in the words of GitHub', async () => {
    const states = ['opened', 'locked', 'merged', 'closed'].map(state => fromMergeRequest({ iid: 12, id: 9001, state, web_url: page })?.state)
    expect(states).toEqual(['OPEN', 'OPEN', 'MERGED', 'CLOSED'])
    // The number is the iid that the page shows, not the id of the instance.
    expect(fromMergeRequest({ iid: 12, id: 9001, state: 'opened', web_url: page })).toEqual({ number: 12, state: 'OPEN', url: page })
  })

  test('anything else is no merge request', async () => {
    for (const json of [
      null,
      [],
      'opened',
      { iid: 12, state: 'opened' },
      { iid: 0, state: 'opened', web_url: page },
      { iid: '12', state: 'opened', web_url: page },
      { iid: 12, state: 'draft', web_url: page },
      { iid: 12, state: 'opened', web_url: 'file:///etc/passwd' },
    ]) {
      expect(fromMergeRequest(json)).toBeUndefined()
    }
  })

  test('GitLab names a pull request a merge request, numbered with !', async () => {
    const gitlab = prWords('gitlab')
    expect([gitlab.label, gitlab.name, gitlab.title, gitlab.ref(12)]).toEqual(['MR', 'merge request', 'Merge request', '!12'])
    for (const host of ['github', 'none', undefined] as const) {
      const words = prWords(host)
      expect([words.label, words.name, words.title, words.ref(12)]).toEqual(['PR', 'pull request', 'Pull request', '#12'])
    }
  })
})
