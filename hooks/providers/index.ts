// The work-item providers the board holds, and what the Plan stage does with them. This list is
// the only place that names them: the check of board.yaml, the parse of the proposal, the read
// of each item's state, a refresh after git, and a click all go through it. A new provider is a
// module that fills in the skeleton of ./base.ts, added to PROVIDERS. A provider never takes `$`:
// it takes the Io that these functions build from it (see ../io.ts).
import type { EngineInterface } from 'claude-code'

import type { PlanHints, PlanningItem, WorkItemRef } from '../../types'
import { asString, sectionHeading } from '../check'
import type { Check, Doc } from '../check'
import { ioOf } from '../io'
import { section } from '../parse'
import type { Collected, Opened, ProviderContext, WorkItemProvider } from './base'
import { fileProvider } from './file'
import { githubProvider } from './github'

// In this order: a line of the proposal belongs to the first provider that names an item in it,
// and the pane lists each provider's items after the ones of the providers before it.
const PROVIDERS: readonly WorkItemProvider[] = [fileProvider, githubProvider]

const named = (name: string): WorkItemProvider | undefined => PROVIDERS.find(provider => provider.name === name)

/** Whether a provider of this name gives work items. */
export const isWorkItemProvider = (name: string): boolean => named(name) !== undefined

/** A `work-item` ref of board.yaml, checked by the provider it names. `before`: the refs read before it. */
export const readWorkItemRef = (doc: Doc, before: readonly WorkItemRef[], check: Check, where: string): WorkItemRef | undefined => {
  const name = asString(doc['provider']) ?? 'file'
  const provider = named(name)
  if (provider === undefined) {
    check.warnings.push(`${where}: provider "${name}" is not built in yet`)

    return undefined
  }
  if (!provider.isMany && before.some(ref => ref.provider === name)) {
    check.warnings.push(`${where}: only the first ${name} reference counts`)

    return undefined
  }

  return provider.ref(doc, check, where)
}

/** The provider of an item. An item written before items named theirs is a GitHub issue or a file's item. */
export const providerOf = (item: PlanningItem): WorkItemRef['provider'] => item.provider ?? (item.issue !== undefined ? 'github' : 'file')

// Hints written before refs existed survive a hot reload without them.
const refsOf = (plan: PlanHints | undefined, provider: WorkItemProvider): WorkItemRef[] =>
  (plan?.refs ?? []).filter(ref => ref.provider === provider.name)

/** The providers the hints give a ref, in the order of PROVIDERS. */
const activeProviders = (plan: PlanHints | undefined): WorkItemProvider[] => PROVIDERS.filter(provider => refsOf(plan, provider).length > 0)

/**
 * The work items a proposal names in the section of the Plan stage, each once, and a
 * `None — <reason>` line. A line belongs to the first provider that names an item in it.
 */
export const planItems = (md: string, plan: PlanHints): { items: PlanningItem[]; none?: string } => {
  const body = section(md, sectionHeading(plan.section))
  const providers = activeProviders(plan)
  const items: PlanningItem[] = []
  const seen = new Set<string>()
  let none: string | undefined
  for (const line of body ?? []) {
    const empty = /^None\s*[—–-]\s*(.*)$/.exec(line.trim())
    if (empty) {
      none = empty[1] ?? ''
      continue
    }
    for (const provider of providers) {
      const found = provider.itemsOfLine(line, refsOf(plan, provider))
      if (found.length === 0) {
        continue
      }
      for (const item of found.filter(candidate => !seen.has(`${provider.name}:${candidate.id}`))) {
        seen.add(`${provider.name}:${item.id}`)
        items.push(item)
      }
      break
    }
  }

  return { items, none }
}

/** The files of the repository whose edits change the work items. */
export const planFiles = (plan: PlanHints | undefined): string[] => activeProviders(plan).flatMap(provider => provider.files(refsOf(plan, provider)))

/** The work items as they stand now: each provider collects the items the proposal gave it. */
export async function collectPlan($: EngineInterface, proposal: readonly PlanningItem[], plan: PlanHints, context: ProviderContext): Promise<Collected> {
  const io = ioOf($)
  const items: PlanningItem[] = []
  const warnings: string[] = []
  for (const provider of activeProviders(plan)) {
    const collected = await provider.collect(
      io,
      proposal.filter(item => providerOf(item) === provider.name),
      refsOf(plan, provider),
      context,
    )
    items.push(...collected.items)
    warnings.push(...collected.warnings)
  }

  return { items, warnings }
}

/**
 * The work items after a read of git alone. A provider that reads git collects again, from the
 * items the proposal gave it, as the branch or the pull request may name others; its earlier
 * warnings give way to the new ones. The other providers keep their items.
 */
export async function refreshPlan(
  $: EngineInterface,
  previous: { planning: readonly PlanningItem[]; warnings: readonly string[] },
  plan: PlanHints | undefined,
  context: ProviderContext,
): Promise<{ planning: PlanningItem[]; warnings: string[] }> {
  const providers = activeProviders(plan)
  if (!providers.some(provider => provider.readsGit)) {
    return { planning: [...previous.planning], warnings: [...previous.warnings] }
  }
  const prefixes = providers.flatMap(provider => (provider.readsGit && provider.warningPrefix !== undefined ? [provider.warningPrefix] : []))
  const io = ioOf($)
  const planning: PlanningItem[] = []
  const warnings = previous.warnings.filter(warning => !prefixes.some(prefix => warning.startsWith(prefix)))
  for (const provider of providers) {
    const own = previous.planning.filter(item => providerOf(item) === provider.name)
    if (!provider.readsGit) {
      planning.push(...own)
      continue
    }
    const proposal = own.filter(item => (item.via ?? 'proposal') === 'proposal')
    const collected = await provider.collect(io, proposal, refsOf(plan, provider), context)
    planning.push(...collected.items)
    warnings.push(...collected.warnings)
  }

  return { planning, warnings }
}

/** What a click on a work item shows, as its provider decides. */
export async function openItem($: EngineInterface, item: PlanningItem, plan: PlanHints | undefined, context: ProviderContext): Promise<Opened> {
  const provider = named(providerOf(item))

  return provider === undefined
    ? { doc: { title: item.id, text: `No provider reads ${item.id}.` } }
    : provider.open(ioOf($), item, refsOf(plan, provider), context)
}

export type { Collected, Opened, ProviderContext, WorkItemProvider } from './base'
