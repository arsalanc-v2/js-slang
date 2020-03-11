import { Literal, Program } from 'estree'
import { SourceMapConsumer } from 'source-map'
import createContext from './createContext'
import { InterruptedError } from './errors/errors'
import { evaluate } from './interpreter/interpreter-non-det'
import { parse, parseAt } from './parser/parser'
import { NonDetScheduler } from './schedulers'
import { setBreakpointAtLine } from './stdlib/inspector'
import { codify, getEvaluationSteps } from './stepper/stepper'

import {
  Context,
  ExecutionMethod,
  Result,
  SourceError,
  SuspendedNonDet,
  ResultNonDet
} from './types'
import { nonDetEvaluate } from './interpreter/interpreter-non-det'
import { validateAndAnnotate } from './validator/validator'

export interface IOptions {
  scheduler: 'preemptive' | 'async' | 'non-det'
  steps: number
  executionMethod: ExecutionMethod
  originalMaxExecTime: number
  useSubst: boolean
}

// needed to work on browsers
// @ts-ignore
SourceMapConsumer.initialize({
  'lib/mappings.wasm': 'https://unpkg.com/source-map@0.7.3/lib/mappings.wasm'
})

// deals with parsing error objects and converting them to strings (for repl at least)

let verboseErrors = false
const resolvedErrorPromise = Promise.resolve({ status: 'error' } as ResultNonDet)

export function parseError(errors: SourceError[], verbose: boolean = verboseErrors): string {
  const errorMessagesArr = errors.map(error => {
    const line = error.location ? error.location.start.line : '<unknown>'
    const column = error.location ? error.location.start.column : '<unknown>'
    const explanation = error.explain()

    if (verbose) {
      // TODO currently elaboration is just tagged on to a new line after the error message itself. find a better
      // way to display it.
      const elaboration = error.elaborate()
      return `Line ${line}, Column ${column}: ${explanation}\n${elaboration}\n`
    } else {
      return `Line ${line}: ${explanation}`
    }
  })
  return errorMessagesArr.join('\n')
}

export async function runInContext(
  code: string,
  context: Context,
  options: Partial<IOptions> = {}
): Promise<ResultNonDet> {
  function getFirstLine(theCode: string) {
    const theProgramFirstExpression = parseAt(theCode, 0)

    if (theProgramFirstExpression && theProgramFirstExpression.type === 'Literal') {
      return ((theProgramFirstExpression as unknown) as Literal).value
    }

    return undefined
  }
  context.errors = []

  verboseErrors = getFirstLine(code) === 'enable verbose'
  const program = parse(code, context)
  if (!program) {
    return resolvedErrorPromise
  }
  validateAndAnnotate(program as Program, context)
  if (context.errors.length > 0) {
    return resolvedErrorPromise
  }
  if (options.useSubst) {
    const steps = getEvaluationSteps(program, context)
    return Promise.resolve({
      status: 'finished',
      value: steps.map(codify)
    } as ResultNonDet)
  }
  if (context.prelude !== null) {
    const prelude = context.prelude
    context.prelude = null
    await runInContext(prelude, context, options)
    return runInContext(code, context, options)
  }

  let it = evaluate(program, context)
  let scheduler: NonDetScheduler
  // theOptions.scheduler = 'non-det'
  it = nonDetEvaluate(program, context)
  scheduler = new NonDetScheduler()
  return scheduler.run(it, context)
}

export function resume(result: SuspendedNonDet): Promise<ResultNonDet> {
  return result.scheduler.run(result.it, result.context) as Promise<ResultNonDet>
}

export function interrupt(context: Context) {
  const globalEnvironment = context.runtime.environments[context.runtime.environments.length - 1]
  context.runtime.environments = [globalEnvironment]
  context.runtime.isRunning = false
  context.errors.push(new InterruptedError(context.runtime.nodes[0]))
}

export { createContext, Context, Result, setBreakpointAtLine }
