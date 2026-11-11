// Pure: the strict check of what a board.yaml holds. A board.yaml can come with any repository,
// so a path must stay inside the repository, an id or a repository name must be plain, and a
// pattern must compile and stay short. The schema reader and each provider check their own
// keys with these. No `$` here.

/** A mapping of board.yaml. */
export type Doc = Record<string, unknown>

/** Where a check collects its warnings: each one drops a part of board.yaml and says why. */
export type Check = { warnings: string[] }

export const MAX_PATTERN = 300

export const isDoc = (value: unknown): value is Doc => typeof value === 'object' && value !== null && !Array.isArray(value)

export const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined

export const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(item => (asString(item) === undefined ? [] : [asString(item) as string])) : typeof value === 'string' ? [value] : []

/**
 * A path relative to the repository root that stays inside it: no drive, no leading slash,
 * no backslash, and no `.` or `..` segment. `{id}` may stand for a design id.
 */
export const isSafePath = (path: string): boolean =>
  path !== '' &&
  !/^[A-Za-z]:|^[\\/]|\\/.test(path) &&
  path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && /^[\w.{}@ -]+$/.test(part))

/** A design id or a work-item id that may name a folder: letters, digits, `_`, and `-`. */
export const isSafeId = (id: string): boolean => /^[A-Za-z0-9][\w-]{0,63}$/.test(id)

/** A GitHub repository as `owner/name`, the form `gh -R` takes. */
export const isRepoName = (repo: string): boolean => /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[\w.-]{1,100}$/.test(repo) && !repo.endsWith('/..') && !repo.endsWith('/.')

/** The pattern, when it compiles and is short; `{change}` stands for a change name. */
export const checkPattern = (pattern: string | undefined, flags = ''): string | undefined => {
  if (pattern === undefined || pattern === '' || pattern.length > MAX_PATTERN) {
    return undefined
  }
  try {
    new RegExp(pattern.replace(/\{change\}/g, 'x'), flags)

    return pattern
  } catch {
    return undefined
  }
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')

/** A hint pattern with `{change}` replaced by the escaped change name. */
export const hintRegex = (pattern: string, change: string, flags = ''): RegExp | undefined => {
  try {
    return new RegExp(pattern.replace(/\{change\}/g, escapeRegex(change)), flags)
  } catch {
    return undefined
  }
}

/** The heading pattern of a proposal section, from names separated by `|`. */
export const sectionHeading = (section: string): RegExp =>
  new RegExp(`^##\\s+(?:${section.split('|').map(name => escapeRegex(name.trim())).join('|')})\\s*$`)

/** A path of board.yaml, when it stays inside the repository. */
export const pathHint = (check: Check, where: string, value: unknown): string | undefined => {
  const path = asString(value)
  if (path === undefined) {
    return undefined
  }
  if (!isSafePath(path)) {
    check.warnings.push(`${where}: "${path}" is not a path inside the repository`)

    return undefined
  }

  return path
}

/** A pattern of board.yaml, when it compiles and is short. */
export const patternHint = (check: Check, where: string, value: unknown, flags = ''): string | undefined => {
  const raw = asString(value)
  if (raw === undefined) {
    return undefined
  }
  const pattern = checkPattern(raw, flags)
  if (pattern === undefined) {
    check.warnings.push(`${where}: the pattern does not compile or is longer than ${MAX_PATTERN} characters`)
  }

  return pattern
}
