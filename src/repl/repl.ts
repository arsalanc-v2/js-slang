import fs = require('fs')
import repl = require('repl') // 'repl' here refers to the module named 'repl' in index.d.ts
import util = require('util')
import { createContext, IOptions, parseError, runInContext, resumeNonDet } from '../index'
import { Suspended, Context, Finished } from '../types'

// value yielded for the try_again function when entered by the user
const TRYAGAIN_VALUE = 'try_again'
// stores the result obtained when execution is suspended
let previousResult: Suspended

function resume(context: Context, callback: (err: Error | null, result: any) => void) {
  resumeNonDet(previousResult).then(result => {
    if (result.status === 'error') {
      callback(new Error(parseError(context.errors)), undefined)
      return
    } else if (result.status === 'suspended') {
      previousResult = result
    }

    callback(null, result.value)
  })
}

function try_again(
  result: Finished | Suspended,
  context: Context,
  callback: (err: Error | null, result: any) => void
) {
  if (previousResult && previousResult.status === 'suspended') {
    resume(context, callback)
  } else {
    result.value = undefined
    callback(null, result.value)
  }
}

function run(cmd: any, context: any, options: any, callback: any) {
  runInContext(cmd, context, options).then(result => {
    if (result.status === 'error') {
      callback(new Error(parseError(context.errors)), undefined)
      return
    }

    if (result.value === TRYAGAIN_VALUE) {
      try_again(result, context, callback)
      return
    }

    if (result.status === 'suspended') {
      previousResult = result
    }

    callback(null, result.value)
  })
}

function startRepl(chapter = 1, useSubst: boolean, prelude = '') {
  // use defaults for everything
  const context = createContext(chapter)
  const options: Partial<IOptions> = { scheduler: 'preemptive', useSubst }

  runInContext(prelude, context, options).then(preludeResult => {
    if (preludeResult.status === 'error') {
      throw new Error(parseError(context.errors))
    }

    console.dir(preludeResult.value, { depth: null })
    repl.start(
      // the object being passed as argument fits the interface ReplOptions in the repl module.
      {
        eval: (cmd, unusedContext, unusedFilename, callback) => {
          run(cmd, context, options, callback)
        },
        // set depth to a large number so that `parse()` output will not be folded,
        // setting to null also solves the problem, however a reference loop might crash
        writer: output =>
          util.inspect(output, {
            depth: 1000,
            colors: true
          })
      }
    )
  })
}

function main() {
  const firstArg = process.argv[2]
  if (process.argv.length === 3 && String(Number(firstArg)) !== firstArg.trim()) {
    fs.readFile(firstArg, 'utf8', (err, data) => {
      if (err) {
        throw err
      }
      startRepl(4, false, data)
    })
  } else {
    const chapter = process.argv.length > 2 ? parseInt(firstArg, 10) : 1
    const useSubst = process.argv.length > 3 ? process.argv[3] === 'subst' : false
    startRepl(chapter, useSubst)
  }
}

main()
