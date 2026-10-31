// Pure: a reader for the YAML that OpenSpec schemas and board.yaml files use. No `$` here.
//
// It reads block mappings and sequences, flow collections (also across lines), plain and quoted
// scalars, block scalars (`|` and `>`), and comments. It does not read anchors, aliases, tags, or
// several documents in one file. A line it cannot read throws a YamlError with its line number.

export class YamlError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${line}: ${message}`)
  }
}

type Cursor = { lines: string[]; at: number }

const indentOf = (raw: string): number => raw.length - raw.trimStart().length

const isBlank = (raw: string): boolean => /^\s*(#.*)?$/.test(raw)

/** The text before a comment: a `#` at the start or after a space, outside quotes. */
const stripComment = (text: string): string => {
  let quote: string | undefined
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote === '"' && char === '\\') {
      index++
    } else if (quote !== undefined) {
      if (char === quote) {
        quote = undefined
      }
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '#' && (index === 0 || /\s/.test(text[index - 1] ?? ''))) {
      return text.slice(0, index).trimEnd()
    }
  }

  return text.trimEnd()
}

/** The index of the `:` that ends a block mapping key, or -1 when the text is no key. */
const keyEnd = (text: string): number => {
  if (text.startsWith('[') || text.startsWith('{')) {
    return -1
  }
  let quote: string | undefined
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote === '"' && char === '\\') {
      index++
    } else if (quote !== undefined) {
      if (char === quote) {
        quote = undefined
      }
    } else if ((char === '"' || char === "'") && index === 0) {
      quote = char
    } else if (char === ':' && (index === text.length - 1 || /\s/.test(text[index + 1] ?? ''))) {
      return index
    }
  }

  return -1
}

const isSeqItem = (text: string): boolean => text === '-' || text.startsWith('- ')

const plainScalar = (text: string): unknown => {
  if (/^(true|True|TRUE)$/.test(text)) {
    return true
  }
  if (/^(false|False|FALSE)$/.test(text)) {
    return false
  }
  if (/^(null|Null|NULL|~)?$/.test(text)) {
    return null
  }
  if (/^[-+]?\d+$/.test(text)) {
    return Number(text)
  }
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) {
    return Number(text)
  }

  return text
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', '\\': '\\', '/': '/', ' ': ' ' }

/** A quoted scalar that starts at `pos`; returns its value and the index after it. */
const quoted = (text: string, pos: number, line: number): [string, number] => {
  const quote = text[pos]
  let out = ''
  for (let index = pos + 1; index < text.length; index++) {
    const char = text[index] ?? ''
    if (quote === "'") {
      if (char === "'") {
        if (text[index + 1] === "'") {
          out += "'"
          index++
          continue
        }

        return [out, index + 1]
      }
      out += char
      continue
    }
    if (char === '\\') {
      const next = text[index + 1] ?? ''
      if (next === 'u' || next === 'x') {
        const size = next === 'u' ? 4 : 2
        const hex = text.slice(index + 2, index + 2 + size)
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== size) {
          throw new YamlError(`bad escape \\${next}${hex}`, line)
        }
        out += String.fromCharCode(parseInt(hex, 16))
        index += 1 + size
        continue
      }
      const escaped = ESCAPES[next]
      if (escaped === undefined) {
        throw new YamlError(`bad escape \\${next}`, line)
      }
      out += escaped
      index++
      continue
    }
    if (char === '"') {
      return [out, index + 1]
    }
    out += char
  }
  throw new YamlError('a quoted scalar does not end on its line', line)
}

/** A flow collection or scalar at `pos` of `text`; returns its value and the index after it. */
const flowValue = (text: string, pos: number, line: number): [unknown, number] => {
  let index = pos
  const skip = () => {
    while (index < text.length && /\s/.test(text[index] ?? '')) {
      index++
    }
  }
  skip()
  const char = text[index]
  if (char === '"' || char === "'") {
    return quoted(text, index, line)
  }
  if (char === '[') {
    const items: unknown[] = []
    index++
    for (;;) {
      skip()
      if (text[index] === ']') {
        return [items, index + 1]
      }
      const [item, after] = flowValue(text, index, line)
      items.push(item)
      index = after
      skip()
      if (text[index] === ',') {
        index++
      } else if (text[index] !== ']') {
        throw new YamlError('expected , or ] in a flow sequence', line)
      }
    }
  }
  if (char === '{') {
    const map: Record<string, unknown> = {}
    index++
    for (;;) {
      skip()
      if (text[index] === '}') {
        return [map, index + 1]
      }
      let key: string
      if (text[index] === '"' || text[index] === "'") {
        ;[key, index] = quoted(text, index, line)
      } else {
        const start = index
        while (index < text.length && !/[:,}]/.test(text[index] ?? '')) {
          index++
        }
        key = text.slice(start, index).trim()
      }
      skip()
      let value: unknown = null
      if (text[index] === ':') {
        index++
        skip()
        if (text[index] !== ',' && text[index] !== '}') {
          ;[value, index] = flowValue(text, index, line)
        }
      }
      map[key] = value
      skip()
      if (text[index] === ',') {
        index++
      } else if (text[index] !== '}') {
        throw new YamlError('expected , or } in a flow mapping', line)
      }
    }
  }
  const start = index
  while (index < text.length && !/[,\]}]/.test(text[index] ?? '')) {
    index++
  }

  return [plainScalar(text.slice(start, index).trim()), index]
}

/** The bracket depth left open at the end of `text`, quotes respected. */
const openDepth = (text: string): number => {
  let depth = 0
  let quote: string | undefined
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote === '"' && char === '\\') {
      index++
    } else if (quote !== undefined) {
      if (char === quote) {
        quote = undefined
      }
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '[' || char === '{') {
      depth++
    } else if (char === ']' || char === '}') {
      depth--
    }
  }

  return depth
}

/** A block scalar (`|` or `>`) whose lines are indented deeper than `parent`. */
const blockScalar = (cursor: Cursor, header: string, parent: number): string => {
  const isFolded = header.startsWith('>')
  const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip'
  const body: string[] = []
  let indent: number | undefined
  while (cursor.at < cursor.lines.length) {
    const raw = cursor.lines[cursor.at] ?? ''
    if (raw.trim() === '') {
      body.push('')
      cursor.at++
      continue
    }
    const own = indentOf(raw)
    if (own <= parent) {
      break
    }
    indent ??= own
    if (own < indent) {
      break
    }
    body.push(raw.slice(indent))
    cursor.at++
  }
  let trailing = 0
  while (body.length > 0 && body[body.length - 1] === '') {
    body.pop()
    trailing++
  }
  let text: string
  if (isFolded) {
    // A line break between two lines becomes a space; a blank line stays one line break; a
    // more indented line keeps its breaks.
    text = ''
    body.forEach((line, index) => {
      const previous = body[index - 1]
      if (previous === undefined) {
        text = line
      } else if (line === '') {
        text += '\n'
      } else if (previous === '') {
        text += line
      } else if (/^\s/.test(line) || /^\s/.test(previous)) {
        text += `\n${line}`
      } else {
        text += ` ${line}`
      }
    })
  } else {
    text = body.join('\n')
  }
  if (body.length === 0) {
    return ''
  }

  return chomp === 'strip' ? text : chomp === 'keep' ? text + '\n'.repeat(trailing + 1) : `${text}\n`
}

/** The value after `key:` or `- `: a scalar, a flow collection (perhaps over several lines), or a block scalar. */
const inlineValue = (cursor: Cursor, rest: string, parent: number): unknown => {
  const line = cursor.at
  const text = stripComment(rest)
  if (/^[|>][-+]?$/.test(text)) {
    return blockScalar(cursor, text, parent)
  }
  if (text.startsWith('[') || text.startsWith('{')) {
    let joined = text
    while (openDepth(joined) > 0 && cursor.at < cursor.lines.length) {
      joined += ` ${stripComment((cursor.lines[cursor.at] ?? '').trim())}`
      cursor.at++
    }
    const [value, after] = flowValue(joined, 0, line)
    if (joined.slice(after).trim() !== '') {
      throw new YamlError(`unexpected text after a flow collection: ${joined.slice(after).trim()}`, line)
    }

    return value
  }
  if (text.startsWith('"') || text.startsWith("'")) {
    const [value, after] = quoted(text, 0, line)
    if (text.slice(after).trim() !== '') {
      throw new YamlError('unexpected text after a quoted scalar', line)
    }

    return value
  }
  if (text.startsWith('&') || text.startsWith('*') || text.startsWith('!')) {
    throw new YamlError('anchors, aliases, and tags are not read', line)
  }
  // A plain scalar goes on over the lines indented deeper than its parent, joined by spaces.
  // A deeper line that reads as a key or a list item is no continuation, and the caller refuses it.
  let joined = text
  while (cursor.at < cursor.lines.length) {
    const raw = cursor.lines[cursor.at] ?? ''
    const next = stripComment(raw.trim())
    if (raw.trim() === '' || indentOf(raw) <= parent || keyEnd(next) >= 0 || isSeqItem(next)) {
      break
    }
    joined += ` ${stripComment(raw.trim())}`
    cursor.at++
  }

  return joined === text ? plainScalar(text) : joined
}

const skipBlank = (cursor: Cursor): void => {
  while (cursor.at < cursor.lines.length) {
    const raw = cursor.lines[cursor.at] ?? ''
    if (!isBlank(raw) && raw.trim() !== '---') {
      return
    }
    cursor.at++
  }
}

/** The block node whose first line is indented `min` or deeper, else null. */
const node = (cursor: Cursor, min: number): unknown => {
  skipBlank(cursor)
  if (cursor.at >= cursor.lines.length) {
    return null
  }
  const raw = cursor.lines[cursor.at] ?? ''
  const indent = indentOf(raw)
  if (indent < min) {
    return null
  }
  const text = stripComment(raw.slice(indent))
  if (isSeqItem(text)) {
    return sequence(cursor, indent)
  }
  if (keyEnd(text) >= 0) {
    return mapping(cursor, indent)
  }
  cursor.at++

  return inlineValue(cursor, text, indent - 1)
}

const mapping = (cursor: Cursor, indent: number): Record<string, unknown> => {
  const map: Record<string, unknown> = {}
  for (;;) {
    skipBlank(cursor)
    if (cursor.at >= cursor.lines.length) {
      return map
    }
    const raw = cursor.lines[cursor.at] ?? ''
    const own = indentOf(raw)
    if (own < indent) {
      return map
    }
    const line = cursor.at + 1
    if (own > indent) {
      throw new YamlError('unexpected indentation', line)
    }
    const text = stripComment(raw.slice(own))
    const end = keyEnd(text)
    if (end < 0) {
      if (isSeqItem(text)) {
        return map
      }
      throw new YamlError(`expected a key: ${text}`, line)
    }
    const head = text.slice(0, end).trim()
    const key = head.startsWith('"') || head.startsWith("'") ? quoted(head, 0, line)[0] : head
    const rest = text.slice(end + 1).trim()
    cursor.at++
    if (rest !== '') {
      map[key] = inlineValue(cursor, rest, indent)
      continue
    }
    skipBlank(cursor)
    const next = cursor.lines[cursor.at]
    if (next === undefined) {
      map[key] = null
    } else if (indentOf(next) > indent) {
      map[key] = node(cursor, indent + 1)
    } else if (indentOf(next) === indent && isSeqItem(stripComment(next.trim()))) {
      // A sequence may sit at the indentation of its key.
      map[key] = sequence(cursor, indent)
    } else {
      map[key] = null
    }
  }
}

const sequence = (cursor: Cursor, indent: number): unknown[] => {
  const items: unknown[] = []
  for (;;) {
    skipBlank(cursor)
    if (cursor.at >= cursor.lines.length) {
      return items
    }
    const raw = cursor.lines[cursor.at] ?? ''
    const own = indentOf(raw)
    const text = stripComment(raw.slice(own))
    if (own < indent || !isSeqItem(text)) {
      if (own > indent) {
        throw new YamlError('unexpected indentation', cursor.at + 1)
      }

      return items
    }
    if (own > indent) {
      throw new YamlError('unexpected indentation', cursor.at + 1)
    }
    const content = text.slice(1).trimStart()
    if (content === '') {
      cursor.at++
      items.push(node(cursor, indent + 1))
      continue
    }
    // `- key: value` or `- - item`: the item is a block node that starts at the content's column.
    const column = own + (text.length - content.length)
    if (keyEnd(content) >= 0 || isSeqItem(content)) {
      cursor.lines[cursor.at] = ' '.repeat(column) + content
      items.push(isSeqItem(content) ? sequence(cursor, column) : mapping(cursor, column))
      continue
    }
    cursor.at++
    items.push(inlineValue(cursor, content, own))
  }
}

/** Reads one YAML document. Throws a YamlError on a line it cannot read. */
export const parseYaml = (source: string): unknown => {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/)
  const cursor: Cursor = { lines, at: 0 }
  const value = node(cursor, 0)
  skipBlank(cursor)
  if (cursor.at < lines.length) {
    throw new YamlError('unexpected text after the document', cursor.at + 1)
  }

  return value
}
