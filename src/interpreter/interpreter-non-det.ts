/* tslint:disable:max-classes-per-file */
import * as es from 'estree'
import * as constants from '../constants'
import * as errors from '../errors/errors'
import { RuntimeSourceError } from '../errors/runtimeSourceError'
import { Context, Environment, Frame, Value } from '../types'
import { primitive, conditionalExpression, literal } from '../utils/astCreator'
import { evaluateBinaryExpression, evaluateUnaryExpression } from '../utils/operators'
import * as rttc from '../utils/rttc'
import Closure from './closure'
import { cloneDeep, assignIn } from 'lodash'
import { CUT } from '../constants'

class ReturnValue {
  constructor(public value: Value) {}
}

const createEnvironment = (
  closure: Closure,
  args: Value[],
  callExpression?: es.CallExpression
): Environment => {
  const environment: Environment = {
    name: closure.functionName, // TODO: Change this
    tail: closure.environment,
    head: {}
  }
  if (callExpression) {
    environment.callExpression = {
      ...callExpression,
      arguments: args.map(primitive)
    }
  }
  closure.node.params.forEach((param, index) => {
    const ident = param as es.Identifier
    environment.head[ident.name] = args[index]
  })
  return environment
}

const createBlockEnvironment = (
  context: Context,
  name = 'blockEnvironment',
  head: Frame = {}
): Environment => {
  return {
    name,
    tail: currentEnvironment(context),
    head,
    thisContext: context
  }
}

const handleRuntimeError = (context: Context, error: RuntimeSourceError): never => {
  context.errors.push(error)
  context.runtime.environments = context.runtime.environments.slice(
    -context.numberOfOuterEnvironments
  )
  throw error
}

const HOISTED_BUT_NOT_YET_ASSIGNED = Symbol('Used to implement hoisting')

function hoistIdentifier(context: Context, name: string, node: es.Node) {
  const environment = currentEnvironment(context)
  if (environment.head.hasOwnProperty(name)) {
    const descriptors = Object.getOwnPropertyDescriptors(environment.head)

    return handleRuntimeError(
      context,
      new errors.VariableRedeclaration(node, name, descriptors[name].writable)
    )
  }
  environment.head[name] = HOISTED_BUT_NOT_YET_ASSIGNED
  return environment
}

function hoistVariableDeclarations(context: Context, node: es.VariableDeclaration) {
  for (const declaration of node.declarations) {
    hoistIdentifier(context, (declaration.id as es.Identifier).name, node)
  }
}

function hoistFunctionsAndVariableDeclarationsIdentifiers(
  context: Context,
  node: es.BlockStatement
) {
  for (const statement of node.body) {
    switch (statement.type) {
      case 'VariableDeclaration':
        hoistVariableDeclarations(context, statement)
        break
      case 'FunctionDeclaration':
        hoistIdentifier(context, (statement.id as es.Identifier).name, statement)
        break
    }
  }
}

function defineVariable(context: Context, name: string, value: Value, constant = false) {
  const environment = context.runtime.environments[0]

  if (environment.head[name] !== HOISTED_BUT_NOT_YET_ASSIGNED) {
    return handleRuntimeError(
      context,
      new errors.VariableRedeclaration(context.runtime.nodes[0]!, name, !constant)
    )
  }

  Object.defineProperty(environment.head, name, {
    value,
    writable: !constant,
    enumerable: true
  })

  return environment
}

const currentEnvironment = (context: Context) => context.runtime.environments[0]
const popEnvironment = (context: Context) => context.runtime.environments.shift()
const pushEnvironment = (context: Context, environment: Environment) =>
  context.runtime.environments.unshift(environment)

const getVariable = (context: Context, name: string) => {
  let environment: Environment | null = context.runtime.environments[0]
  while (environment) {
    if (environment.head.hasOwnProperty(name)) {
      if (environment.head[name] === HOISTED_BUT_NOT_YET_ASSIGNED) {
        return handleRuntimeError(
          context,
          new errors.UnassignedVariable(name, context.runtime.nodes[0])
        )
      } else {
        return environment.head[name]
      }
    } else {
      environment = environment.tail
    }
  }
  return handleRuntimeError(context, new errors.UndefinedVariable(name, context.runtime.nodes[0]))
}

const setVariable = (context: Context, name: string, value: any) => {
  let environment: Environment | null = context.runtime.environments[0]
  while (environment) {
    if (environment.head.hasOwnProperty(name)) {
      if (environment.head[name] === HOISTED_BUT_NOT_YET_ASSIGNED) {
        break
      }
      const descriptors = Object.getOwnPropertyDescriptors(environment.head)
      if (descriptors[name].writable) {
        environment.head[name] = value
        return undefined
      }
      return handleRuntimeError(
        context,
        new errors.ConstAssignment(context.runtime.nodes[0]!, name)
      )
    } else {
      environment = environment.tail
    }
  }
  return handleRuntimeError(context, new errors.UndefinedVariable(name, context.runtime.nodes[0]))
}

const checkNumberOfArguments = (
  context: Context,
  callee: Closure,
  args: Value[],
  exp: es.CallExpression
) => {
  if (callee.node.params.length !== args.length) {
    return handleRuntimeError(
      context,
      new errors.InvalidNumberOfArguments(exp, callee.node.params.length, args.length)
    )
  }
  return undefined
}

function* getArgs(context: Context, call: es.CallExpression) {
  const args = cloneDeep(call.arguments)
  return yield* cartesianProduct(context, args as es.Expression[], [])
}

/* Given a list of non deterministic nodes, this generator returns every
 * combination of values of these nodes */
function* cartesianProduct(
  context: Context,
  nodes: es.Expression[],
  nodeValues: Value[]
): IterableIterator<Value[]> {
  if (nodes.length === 0) {
    yield nodeValues
  } else {
    const currentNode = nodes.shift()! // we need the postfix ! to tell compiler that nodes array is nonempty
    const nodeValueGenerator = evaluate(currentNode, context)
    let nodeValue = nodeValueGenerator.next()
    while (!nodeValue.done) {
      nodeValues.push(nodeValue.value)
      yield* cartesianProduct(context, nodes, nodeValues)
      nodeValues.pop()
      nodeValue = nodeValueGenerator.next()
    }
    nodes.unshift(currentNode)
  }
}

function* getAmbArgs(context: Context, call: es.CallExpression) {
  const originalContext = cloneDeep(context)
  for (const arg of call.arguments) {
    yield* evaluate(arg, context)
    assignIn(context, cloneDeep(originalContext)) // reset context
  }
}

function transformLogicalExpression(node: es.LogicalExpression): es.ConditionalExpression {
  if (node.operator === '&&') {
    return conditionalExpression(node.left, node.right, literal(false), node.loc!)
  } else {
    return conditionalExpression(node.left, literal(true), node.right, node.loc!)
  }
}

function* evaluateRequire(context: Context, call: es.CallExpression) {
  if (call.arguments.length !== 1) {
    return yield handleRuntimeError(
      context,
      new errors.InvalidNumberOfArguments(call, 1, call.arguments.length)
    )
  }

  const predicate = call.arguments[0]
  const predicateGenerator = evaluate(predicate, context)
  let predicateValue = predicateGenerator.next()

  while (!predicateValue.done) {
    if (predicateValue.value) {
      yield 'Satisfied require'
    }
    predicateValue = predicateGenerator.next()
  }
}

function* reduceIf(
  node: es.IfStatement | es.ConditionalExpression,
  context: Context
): IterableIterator<es.Node> {
  const testGenerator = evaluate(node.test, context)
  let test = testGenerator.next()
  while (!test.done) {
    const error = rttc.checkIfStatement(node, test.value)
    if (error) {
      return handleRuntimeError(context, error)
    }
    yield test.value ? node.consequent : node.alternate!

    test = testGenerator.next()
  }
}

export type Evaluator<T extends es.Node> = (node: T, context: Context) => IterableIterator<Value>

function* evaluateBlockSatement(context: Context, node: es.BlockStatement) {
  hoistFunctionsAndVariableDeclarationsIdentifiers(context, node)
  yield* evaluateSequence(context, node.body)
}

function* evaluateSequence(context: Context, sequence: es.Statement[]): IterableIterator<Value> {
  if (sequence.length === 0) {
    return yield undefined // repl does not work unless we handle this case --> Why?
  }
  const firstStatement = sequence[0]
  const sequenceValGenerator = evaluate(firstStatement, context)
  if (sequence.length === 1) {
    yield* sequenceValGenerator
  } else {
    sequence.shift()
    let sequenceValue = sequenceValGenerator.next()

    // prevent unshifting of cut operator
    let shouldUnshift = sequenceValue.value !== CUT

    while (!sequenceValue.done) {
      if (sequenceValue.value instanceof ReturnValue) {
        yield sequenceValue.value
        sequenceValue = sequenceValGenerator.next()
        continue
      }

      const res = yield* evaluateSequence(context, sequence)
      if (res === CUT) {
        // prevent unshifting of statenents before cut
        shouldUnshift = false
        break
      }

      sequenceValue = sequenceValGenerator.next()
    }

    if (shouldUnshift) sequence.unshift(firstStatement)
    else return CUT
  }
}

function* evaluateConditional(node: es.IfStatement | es.ConditionalExpression, context: Context) {
  const branchGenerator = reduceIf(node, context)
  let branch = branchGenerator.next()
  while (!branch.done) {
    yield* evaluate(branch.value, context)
    branch = branchGenerator.next()
  }
}

/**
 * WARNING: Do not use object literal shorthands, e.g.
 *   {
 *     *Literal(node: es.Literal, ...) {...},
 *     *ThisExpression(node: es.ThisExpression, ..._ {...},
 *     ...
 *   }
 * They do not minify well, raising uncaught syntax errors in production.
 * See: https://github.com/webpack/webpack/issues/7566
 */
// tslint:disable:object-literal-shorthand
// prettier-ignore
export const evaluators: { [nodeType: string]: Evaluator<es.Node> } = {
  /** Simple Values */
  Literal: function*(node: es.Literal, context: Context) {
    yield node.value
  },

  FunctionExpression: function*(node: es.FunctionExpression, context: Context) {
    yield new Closure(node, currentEnvironment(context), context)
  },

  ArrowFunctionExpression: function*(node: es.ArrowFunctionExpression, context: Context) {
    yield Closure.makeFromArrowFunction(node, currentEnvironment(context), context)
  },

  Identifier: function*(node: es.Identifier, context: Context) {
    if (node.name === 'cut') {
      return yield CUT
    }

    yield getVariable(context, node.name)
    return
  },

  CallExpression: function*(node: es.CallExpression, context: Context) {
    const callee = node.callee;
    if (rttc.isIdentifier(callee)) {
      if (callee.name === 'amb') {
        return yield* getAmbArgs(context, node)
      } else if (callee.name === 'require') {
        return yield* evaluateRequire(context, node)
      }
    }

    const calleeGenerator = evaluate(node.callee, context)
    let calleeValue = calleeGenerator.next()
    while (!calleeValue.done) {
      const argsGenerator = getArgs(context, node)
      let args = argsGenerator.next()
      const thisContext = undefined;

      while(!args.done) {
        yield* apply(context, calleeValue.value, args.value, node, thisContext)
        args = argsGenerator.next();
      }
      calleeValue = calleeGenerator.next();
    }
  },

  UnaryExpression: function*(node: es.UnaryExpression, context: Context) {
    const argGenerator = evaluate(node.argument, context)
    let argValue = argGenerator.next()

    while (!argValue.done) {
      const error = rttc.checkUnaryExpression(node, node.operator, argValue.value)
      if (error) {
        return handleRuntimeError(context, error)
      }

      yield evaluateUnaryExpression(node.operator, argValue.value)
      argValue = argGenerator.next()
    }
    return
  },

  BinaryExpression: function*(node: es.BinaryExpression, context: Context) {
    const leftGenerator = evaluate(node.left, context)
    let leftValue = leftGenerator.next();

    while (!leftValue.done) {
      const rightGenerator = evaluate(node.right, context)
      let rightValue = rightGenerator.next();
      while (!rightValue.done) {
        const error = rttc.checkBinaryExpression(node, node.operator, leftValue.value, rightValue.value)
        if (error) {
          return handleRuntimeError(context, error)
        }
        yield evaluateBinaryExpression(node.operator, leftValue.value, rightValue.value)
        rightValue = rightGenerator.next();
      }

      leftValue = leftGenerator.next();
    }
    return
  },

  ConditionalExpression: function*(node: es.ConditionalExpression, context: Context) {
    yield* evaluateConditional(node, context)
  },

  LogicalExpression: function*(node: es.LogicalExpression, context: Context) {
    const conditional: es.ConditionalExpression = transformLogicalExpression(node)
    yield* evaluateConditional(conditional, context)
  },

  VariableDeclaration: function*(node: es.VariableDeclaration, context: Context) {
    const declaration = node.declarations[0]
    const constant = node.kind === 'const'
    const id = declaration.id as es.Identifier
    const valueGenerator = evaluate(declaration.init!, context)
    let value = valueGenerator.next()

    while(!value.done) {
      defineVariable(context, id.name, value.value, constant)
      yield "Declared variable " + id.name + " with value " + value.value
      value = valueGenerator.next()
    }
    return undefined
  },

  AssignmentExpression: function*(node: es.AssignmentExpression, context: Context) {
    const id = node.left as es.Identifier

    const valueGenerator = evaluate(node.right, context)
    let value = valueGenerator.next()
    while (!value.done) {
      setVariable(context, id.name, value.value)
      yield value.value

      value = valueGenerator.next()
    }
  },

  FunctionDeclaration: function*(node: es.FunctionDeclaration, context: Context) {
    const id = node.id as es.Identifier
    // tslint:disable-next-line:no-any
    const closure = new Closure(node, currentEnvironment(context), context)
    defineVariable(context, id.name, closure, true)
    yield undefined
  },

  IfStatement: function*(node: es.IfStatement, context: Context) {
    yield* evaluateConditional(node, context)
  },

  ExpressionStatement: function*(node: es.ExpressionStatement, context: Context) {
    return yield* evaluate(node.expression, context)
  },


  ReturnStatement: function*(node: es.ReturnStatement, context: Context) {
    const returnExpression = node.argument!

    const returnValueGenerator = evaluate(returnExpression, context)
    let returnValue = returnValueGenerator.next()
    while(!returnValue.done) {
      yield new ReturnValue(returnValue.value)
      returnValue = returnValueGenerator.next()
    }

  },

  BlockStatement: function*(node: es.BlockStatement, context: Context) {
    let result: Value

    // Create a new environment (block scoping)
    const environment = createBlockEnvironment(context, 'blockEnvironment')
    pushEnvironment(context, environment)
    result = yield* evaluateBlockSatement(context, node)
    popEnvironment(context)
    return result
  },

  Program: function*(node: es.BlockStatement, context: Context) {
    context.numberOfOuterEnvironments += 1
    const environment = createBlockEnvironment(context, 'programEnvironment')
    pushEnvironment(context, environment)
    return yield* evaluateBlockSatement(context, node)
  }
}
// tslint:enable:object-literal-shorthand

export function* evaluate(node: es.Node, context: Context) {
  const result = yield* evaluators[node.type](node, context)
  return result
}

export function* apply(
  context: Context,
  fun: Closure | Value,
  args: Value[],
  node: es.CallExpression,
  thisContext?: Value
) {
  // This function takes a value that may be a ReturnValue.
  // If so, it returns the value wrapped in the ReturnValue.
  // If not, it returns the default value.
  function unwrapReturnValue(result: any, defaultValue: any) {
    if (result instanceof ReturnValue) {
      return result.value
    } else {
      return defaultValue
    }
  }

  if (fun instanceof Closure) {
    checkNumberOfArguments(context, fun, args, node!)
    const environment = createEnvironment(fun, args, node)
    environment.thisContext = thisContext
    pushEnvironment(context, environment)
    const applicationValueGenerator = evaluateBlockSatement(
      context,
      cloneDeep(fun.node.body) as es.BlockStatement
    )
    for (const applicationValue of applicationValueGenerator) {
      popEnvironment(context)
      yield unwrapReturnValue(applicationValue, undefined)
      pushEnvironment(context, environment)
    }
  } else if (typeof fun === 'function') {
    try {
      yield fun.apply(thisContext, args)
    } catch (e) {
      // Recover from exception
      context.runtime.environments = context.runtime.environments.slice(
        -context.numberOfOuterEnvironments
      )

      const loc = node ? node.loc! : constants.UNKNOWN_LOCATION
      if (!(e instanceof RuntimeSourceError || e instanceof errors.ExceptionError)) {
        // The error could've arisen when the builtin called a source function which errored.
        // If the cause was a source error, we don't want to include the error.
        // However if the error came from the builtin itself, we need to handle it.
        return handleRuntimeError(context, new errors.ExceptionError(e, loc))
      }
      throw e
    }
  } else {
    return handleRuntimeError(context, new errors.CallingNonFunctionValue(fun, node))
  }

  popEnvironment(context)
  return
}

export { evaluate as nonDetEvaluate }
