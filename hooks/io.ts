// What a module of the board may do outside it: read a file, and run a read command. The engine's
// loader follows `$` only through calls it can resolve, so a module reached through an object
// (a provider) never takes `$`: it takes these two functions, built here where `$` is spelled.
import type { EngineInterface } from 'claude-code'

export type RunResult = Awaited<ReturnType<EngineInterface['process']['run']>>

export type Io = {
  /** A file's text, or undefined when it cannot be read. */
  read(path: string): Promise<string | undefined>
  /** A command run by argv, with no shell; undefined when it cannot start. */
  run(argv: readonly string[], cwd: string, timeoutMs?: number): Promise<RunResult | undefined>
}

// A function declaration: past an import, the loader follows `$` only into one.
export function ioOf($: EngineInterface): Io {
  return {
    read: path =>
      $.fs.read(path).then(
        text => (typeof text === 'string' ? text : undefined),
        () => undefined,
      ),
    run: (argv, cwd, timeoutMs = 20_000) => $.process.run(argv, { cwd, timeoutMs }).catch(() => undefined),
  }
}
