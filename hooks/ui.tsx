// The drawing kit of the board pane: the glyphs and colours of a state, the layout widths, and the
// small helpers each section draws with. The pane (./view.tsx) and the section of each stage
// (./stages) share it. No `$` here: the pane resolves the elements and hands them over.
import type { EngineInterface, RenderChildren } from 'claude-code'

import type { AgentRun, Verdict } from '../types'
import type { GroupView, Stage, StageState } from './stages/base'

export type Elements = ReturnType<EngineInterface['ui']['resolve']>

export const STAGE_GLYPH: Record<StageState, string> = { done: '✔', active: '▶', pending: '○', blocked: '✖', partial: '◐', na: '–' }
export const STAGE_COLOR: Record<StageState, string | undefined> = {
  done: 'success',
  active: 'warning',
  pending: undefined,
  blocked: 'error',
  partial: 'suggestion',
  na: undefined,
}
export const GROUP_GLYPH: Record<GroupView['state'], string> = { done: '✔', running: '▶', paused: '‖', partial: '◐', pending: '○' }
export const GROUP_COLOR: Record<GroupView['state'], string | undefined> = {
  done: 'success',
  running: 'warning',
  paused: 'warning',
  partial: 'suggestion',
  pending: undefined,
}
export const TASK_GLYPH: Record<string, string> = { x: '✔', '~': '◐', '-': '✕', '!': '✖', ' ': '○' }
export const VERDICT_COLOR: Record<Verdict['level'], string> = { ok: 'success', warn: 'warning', block: 'error' }
export const MARK_COLOR: Record<string, string | undefined> = { x: 'success', '~': 'warning', '!': 'error' }

// Layout, in character cells: section bodies sit under their header, and the tasks and
// spec files under their row, each with a tree connector.
export const INDENT = 2
export const TREE_INDENT = 5
// The right-hand notes and the row columns end this far from the pane edge, under the end of the stage chip.
export const RIGHT_INSET = 2

export const clip = (text: string, width: number): string =>
  width <= 1 ? text.slice(0, Math.max(0, width)) : text.length <= width ? text : `${text.slice(0, width - 1)}…`

export const fit = (text: string, width: number): string => clip(text, width).padEnd(Math.max(0, width))

/** The tree connector of a row: the last one closes the branch. */
export const branch = (index: number, count: number): string => (index === count - 1 ? '└ ' : '├ ')

export const elapsed = (agent: AgentRun, now: number): number =>
  agent.durationMs ?? (agent.status === 'running' ? now - agent.startedAt : (agent.endedAt ?? now) - agent.startedAt)

/** Word-wraps `text` to `width` cells; a word longer than a line is cut across lines. */
export const wrapWords = (text: string, width: number): string[] => {
  const size = Math.max(1, width)
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word
    while (rest.length > size) {
      if (line !== '') {
        out.push(line)
        line = ''
      }
      out.push(rest.slice(0, size))
      rest = rest.slice(size)
    }
    if (line === '') {
      line = rest
    } else if (line.length + 1 + rest.length <= size) {
      line = `${line} ${rest}`
    } else {
      out.push(line)
      line = rest
    }
  }
  if (line !== '') {
    out.push(line)
  }

  return out
}

/**
 * A card that appears while its task row is hovered (the row and the card share a hover
 * `scope`). A floating Box paints over what comes before it and under what comes after, so
 * the card sits just above its row, over the earlier rows, and never over its own row. Each
 * line is padded to the card's width, so the card's spaces hide the text beneath it.
 */
export const hoverCard = (Box: Elements['Box'], Text: Elements['Text'], text: string, width: number, left: number, scope: string) => {
  const inner = Math.max(10, width - 4)
  const lines = wrapWords(text, inner).map(line => ` ${line.padEnd(inner)} `)

  return (
    <Box
      position="absolute"
      top={-(lines.length + 2)}
      left={left}
      width={inner + 4}
      display="none"
      hover={{ scope, display: 'flex' }}
      flexDirection="column"
      borderStyle="round"
      borderColor="suggestion"
    >
      <Text>{lines.join('\n')}</Text>
    </Box>
  )
}

/** What a section draws with: the elements of the surface, the width of its rows, and its frame. */
export type Kit = {
  Box: Elements['Box']
  Text: Elements['Text']
  Button: Elements['Button']
  /** The width of a section's rows. */
  body: number
  /** A section: its header (fold arrow, title in the stage's colour, a note on the right), then its rows, indented. */
  section: (key: string, title: string, state: StageState | undefined, byDefault: boolean, note: RenderChildren, rows: () => RenderChildren) => RenderChildren
  /** A dim note on the right of a section header; none for an empty text. */
  noteText: (text: string | undefined) => RenderChildren
}

/** A row of the shared "& ship" section: the stage's glyph and label, and a note; a button when it acts. */
export const shipRow = (kit: Kit, key: string | undefined, stage: Stage, note: string | undefined, onPress?: () => void) => {
  const { Text, Button, body } = kit
  const content = [
    <Text color={STAGE_COLOR[stage.state]}>{`${STAGE_GLYPH[stage.state]} `}</Text>,
    <Text bold={stage.state !== 'pending'} dimColor={stage.state === 'pending'}>{` ${fit(stage.label, 8)}`}</Text>,
    note === undefined ? '' : <Text dimColor>{clip(note, body - 12)}</Text>,
  ]

  return key === undefined || onPress === undefined ? (
    <Text wrap="truncate-end">{content}</Text>
  ) : (
    <Button key={key} plain onPress={onPress}>
      {content}
    </Button>
  )
}
