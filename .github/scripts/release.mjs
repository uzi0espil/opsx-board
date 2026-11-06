// Plans a release of the plugin, as the Release workflow runs it:
//
//   node .github/scripts/release.mjs [notes file]
//
// It reads the version in plugin.json, finds the last release tag, and reads the commits since.
// It refuses a version that is lower than the commits ask for, and writes the release notes,
// sorted by the Conventional Commit type of each commit. Without a file, it prints the notes.
// In a workflow, it adds `tag`, `version`, and `previous` to the step outputs.

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
const HEADER = /^(\w+)(?:\(([^)]+)\))?(!)?: (.+)$/
const PR_SUFFIX = /\s*\(#(\d+)\)$/
const BREAKING_NOTE = /^BREAKING[ -]CHANGE: (.+)$/m

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

function fail(message) {
  console.error(`::error::${message}`)
  process.exit(1)
}

const parseVersion = text => SEMVER.exec(text)?.slice(1).map(Number)
const compareVersions = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

const manifest = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'))
const prefix = `${manifest.name}--v`
const tag = `${prefix}${manifest.version}`
const version = parseVersion(manifest.version) ?? fail(`The version "${manifest.version}" in plugin.json is not X.Y.Z.`)
const repoUrl = process.env.GITHUB_REPOSITORY
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
  : manifest.repository

if (git('tag', '--list', tag) !== '') {
  fail(`The tag ${tag} exists already. Raise the version in plugin.json in a pull request first.`)
}

const previous = git('tag', '--list', `${prefix}*`, '--merged', 'HEAD')
  .split('\n')
  .filter(name => parseVersion(name.slice(prefix.length)) !== undefined)
  .sort((a, b) => compareVersions(parseVersion(a.slice(prefix.length)), parseVersion(b.slice(prefix.length))))
  .at(-1)

const log = git('log', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', previous ? `${previous}..HEAD` : 'HEAD')
const commits = log
  .split('\x1e')
  .map(entry => entry.trim())
  .filter(entry => entry !== '')
  .map(entry => {
    const [hash, subject, body] = entry.split('\x1f')
    const pr = PR_SUFFIX.exec(subject)?.[1]
    const title = subject.replace(PR_SUFFIX, '')
    const header = HEADER.exec(title)
    const note = BREAKING_NOTE.exec(body ?? '')?.[1]

    return {
      hash,
      pr,
      title,
      type: header?.[1].toLowerCase(),
      scope: header?.[2],
      description: header?.[4],
      note,
      isBreaking: header !== null && (header[3] === '!' || note !== undefined),
    }
  })
  .filter(commit => !(commit.type === 'chore' && commit.scope === 'release'))

if (commits.length === 0) {
  fail(`No commits since ${previous}.`)
}

if (previous !== undefined) {
  const last = parseVersion(previous.slice(prefix.length))
  const isBreaking = commits.some(commit => commit.isBreaking)
  const isFeature = commits.some(commit => commit.type === 'feat')
  let least = [last[0], last[1], last[2] + 1]
  if (isBreaking && last[0] > 0) {
    least = [last[0] + 1, 0, 0]
  } else if (isBreaking || isFeature) {
    least = [last[0], last[1] + 1, 0]
  }
  if (compareVersions(version, least) < 0) {
    const why = isBreaking ? 'a breaking change' : isFeature ? 'a feature' : 'a change'
    fail(`The commits since ${previous} hold ${why}, so the version must be ${least.join('.')} or higher, not ${manifest.version}. Raise it in plugin.json in a pull request.`)
  }
}

const links = commit =>
  (commit.pr ? ` ([#${commit.pr}](${repoUrl}/pull/${commit.pr}))` : '') +
  ` ([${commit.hash.slice(0, 7)}](${repoUrl}/commit/${commit.hash}))`
const typed = (commit, text) => `* ${commit.scope ? `**${commit.scope}:** ` : ''}${text}${links(commit)}`

const sections = [
  ['Breaking changes', commits.filter(c => c.isBreaking).map(c => typed(c, c.note ?? c.description))],
  ['Features', commits.filter(c => !c.isBreaking && c.type === 'feat').map(c => typed(c, c.description))],
  ['Bug fixes', commits.filter(c => !c.isBreaking && c.type === 'fix').map(c => typed(c, c.description))],
  ['Performance', commits.filter(c => !c.isBreaking && c.type === 'perf').map(c => typed(c, c.description))],
  [
    'Other changes',
    commits
      .filter(c => !c.isBreaking && !['feat', 'fix', 'perf'].includes(c.type))
      .map(c => `* ${c.title}${links(c)}`),
  ],
]

const changelog = previous ? `${repoUrl}/compare/${previous}...${tag}` : `${repoUrl}/commits/${tag}`
const notes = [
  ...sections.filter(([, lines]) => lines.length > 0).map(([heading, lines]) => `### ${heading}\n\n${lines.join('\n')}\n`),
  `**Full changelog:** ${changelog}\n`,
].join('\n')

const file = process.argv[2]
if (file) {
  writeFileSync(file, notes)
} else {
  process.stdout.write(notes)
}
console.error(`tag=${tag} version=${manifest.version} previous=${previous ?? 'none'} commits=${commits.length}`)
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\nversion=${manifest.version}\nprevious=${previous ?? ''}\n`)
}
