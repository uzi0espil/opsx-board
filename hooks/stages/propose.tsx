// The Propose stage: the artifacts of the change's schema, each after the artifacts it requires,
// written by `/opsx:propose`, `/opsx:new`, and `/opsx:continue`. A review artifact may state a
// verdict that blocks the change. Propose ends when Apply starts: until then, the person reviews
// the artifacts and they can still change.
import type { ArtifactRow } from '../../types'
import { phaseOfCommand } from '../parse'
import { INDENT, STAGE_COLOR, STAGE_GLYPH, TREE_INDENT, VERDICT_COLOR, branch, fit } from '../ui'
import type { NextStep, PaneContext, Stage, StageContext, StageKind, StageState } from './base'
import { stageOf } from './base'
import { isApplyStarted } from './apply'
import { blockingVerdict } from './evidence'

const artifactState = (artifact: ArtifactRow): StageState =>
  artifact.status === 'done' ? 'done' : artifact.status === 'ready' ? 'active' : artifact.status === 'skipped' ? 'na' : 'pending'

export const proposeStage: StageKind = {
  key: 'propose',

  /**
   * Done once the change is archived, or planned and applying. A pull request of the branch is no
   * sign: the branch can hold one before the change applies. Blocked by a blocking verdict; in
   * review once every artifact is written.
   */
  evaluate(ctx: StageContext): Stage {
    const { snap, recentCommand, hints } = ctx
    const isProposeCommand = recentCommand !== undefined && phaseOfCommand(recentCommand, hints) === 'propose'
    const state: StageState =
      snap === null
        ? 'pending'
        : ctx.isArchived || (snap.isPlanningComplete && isApplyStarted(ctx))
          ? 'done'
          : blockingVerdict(snap) !== undefined
            ? 'blocked'
            : snap.exists || isProposeCommand
              ? 'active'
              : 'pending'
    const verdictNote = snap?.verdicts?.map(verdict => verdict.value).join(', ')

    return {
      key: 'propose',
      label: 'Propose',
      isOptional: false,
      state,
      note: verdictNote === '' ? undefined : verdictNote,
      isInReview: state === 'active' && snap?.isPlanningComplete === true,
      isRunning: ctx.isCommandRunning('propose') || ctx.isAgentRunning('propose'),
    }
  },

  /**
   * Before any change: propose once the design is approved, or once the exploration settles. For
   * a change: propose it when it has no folder, revise it when a verdict blocks it, and continue
   * while artifacts remain.
   */
  next(ctx: StageContext, stages: readonly Stage[]): NextStep | undefined {
    const { snap, live, hints, change } = ctx
    // No change yet: design mode keeps an empty change name in its snapshot.
    if (snap === null || change === undefined) {
      const designs = snap?.designs ?? []
      const isApproved = live.designRuns.length > 0 && designs.length > 0 && designs.every(view => view.approvedAt !== undefined)
      if (isApproved) {
        return { text: '/opsx:propose ', why: 'the design is approved' }
      }
      if (stageOf(stages, 'explore')?.state === 'active') {
        const command = hints?.design?.command
        const first = command === undefined ? '' : `. Work with a design runs /${command} <name> first`

        return { text: '/opsx:propose ', why: `when the exploration settles, it becomes a change${first}` }
      }

      return undefined
    }
    if (!snap.exists) {
      return { text: `/opsx:propose ${change}`, why: 'no change folder yet' }
    }
    const blocking = blockingVerdict(snap)
    if (stageOf(stages, 'propose')?.state === 'blocked' && blocking !== undefined) {
      return {
        text: (blocking.next ?? '/opsx:continue {change}').replace(/\{change\}/g, change),
        why: `the ${blocking.artifact} verdict is ${blocking.value}. Revise the artifacts`,
      }
    }
    if (!snap.isPlanningComplete) {
      const ready = snap.artifacts.filter(artifact => artifact.status === 'ready').map(artifact => artifact.id)

      return { text: `/opsx:continue ${change}`, why: ready.length === 0 ? 'planning artifacts remain' : `next: ${ready.join(', ')}` }
    }

    return undefined
  },

  /** A row per artifact, which opens its file in the reader; the specs row lists its spec files. */
  section(pane: PaneContext, stage: Stage | undefined) {
    const snap = pane.ctx.snap
    if (snap === null) {
      return null
    }
    const { Box, Text, Button, section } = pane.kit
    const { actions, expanded } = pane
    const artifactsDone = snap.artifacts.filter(artifact => artifact.status === 'done').length
    const verdicts = snap.verdicts ?? []
    const isSpecsOpen = expanded['specs'] === true
    const openArtifact = (artifact: ArtifactRow) => () => {
      if (artifact.status !== 'done') {
        actions.toast(`${artifact.id} is not written yet`)
        return
      }
      const output = artifact.outputPath ?? `${artifact.id}.md`
      if (output.includes('*')) {
        void actions.setExpanded('specs', !isSpecsOpen)
        return
      }
      void actions.read({ title: `${output} · ${snap.change}`, path: `${snap.dir}/${output}`, from: `artifact:${artifact.id}` })
    }
    const proposeNote = (
      <Text dimColor>
        {`${artifactsDone}/${snap.artifacts.length} artifacts`}
        {stage?.isInReview ? ' · in review' : ''}
        {verdicts.flatMap(verdict => [' · ', <Text color={VERDICT_COLOR[verdict.level]}>{verdict.value}</Text>])}
      </Text>
    )
    const idWidth = Math.max(...snap.artifacts.map(artifact => artifact.id.length), 8)

    return section('propose', 'Propose', stage?.state, stage?.state !== 'done', proposeNote, () =>
      snap.artifacts.flatMap(artifact => {
        const state = artifactState(artifact)
        const isGlob = (artifact.outputPath ?? '').includes('*')
        const verdict = verdicts.find(item => item.artifact === artifact.id)
        const detail =
          verdict !== undefined
            ? `${verdict.value}${verdict.note === undefined ? '' : ` (${verdict.note})`}`
            : isGlob && snap.specsCount > 0
              ? `${snap.specsCount} ${snap.specsCount === 1 ? 'file' : 'files'} ${isSpecsOpen ? '▾' : '▸'}`
              : artifact.status === 'blocked' && (artifact.missing?.length ?? 0) > 0
                ? `blocked · needs ${artifact.missing?.join(', ')}`
                : artifact.status === 'blocked' || artifact.status === 'ready'
                  ? artifact.status
                  : ''
        const row = (
          <Button key={`artifact:${artifact.id}`} plain onPress={openArtifact(artifact)}>
            <Text color={STAGE_COLOR[state]}>{`${STAGE_GLYPH[state]} `}</Text>
            <Text>{` ${fit(artifact.id, idWidth)}`}</Text>
            {detail === '' ? '' : <Text color={verdict === undefined ? undefined : VERDICT_COLOR[verdict.level]} dimColor={verdict === undefined}>{`  ${detail}`}</Text>}
          </Button>
        )
        if (!isGlob || !isSpecsOpen) {
          return [row]
        }

        return [
          row,
          <Box flexDirection="column" paddingLeft={TREE_INDENT - INDENT}>
            {snap.specs.map((name, index) => (
              <Button
                key={`spec:${name}`}
                plain
                onPress={() =>
                  void actions.read({
                    title: `specs/${name}/spec.md · ${snap.change}`,
                    path: `${snap.dir}/specs/${name}/spec.md`,
                    from: `spec:${name}`,
                  })
                }
              >
                <Text dimColor>{branch(index, snap.specs.length)}</Text>
                {name}
              </Button>
            ))}
          </Box>,
        ]
      }),
    )
  },
}
