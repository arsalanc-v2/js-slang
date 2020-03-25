/* tslint:disable:max-line-length */
import { runInContext, resume, IOptions, Result } from '../index'
import { mockContext } from '../mocks/context'
import { SuspendedNonDet, Finished } from '../types'

// ---------------------------------- Deterministic code tests --------------------------------
test('Empty code returns undefined', async () => {
  await testDeterministicCode('', undefined)
})

test('Deterministic calculation', async () => {
  await testDeterministicCode('1 + 4 - 10 * 5;', -45)
})

test('Deterministic function applications', async () => {
  await testDeterministicCode(
    `function factorial(n) {
      return n === 0 ? 1 : n * factorial(n - 1);
     }
     factorial(5);
    `,
    120
  )

  await testDeterministicCode(
    `function noReturnStatement_returnsUndefined() {
       20 + 40 - 6;
       5 - 5;
       list();
       reverse(list(1));
     }`,
    undefined
  )
})

test('Test builtin list functions', async () => {
  await testDeterministicCode('pair(false, 10);', [false, 10])
  await testDeterministicCode('list();', null)
  await testDeterministicCode('list(1);', [1, null])
  await testDeterministicCode('head(list(1));', 1)
  await testDeterministicCode('tail(list(1));', null)
})

test('Test prelude list functions', async () => {
  await testDeterministicCode('is_null(null);', true)
  await testDeterministicCode('is_null(list(null));', false)
  await testDeterministicCode(
    `function increment(n) { return n + 1; }
     map(increment, list(100, 101, 200));
    `,
    [101, [102, [201, null]]]
  )
  await testDeterministicCode('append(list(5), list(6,20));', [5, [6, [20, null]]])
  await testDeterministicCode('append(list(4,5), list());', [4, [5, null]])
  await testDeterministicCode('reverse(list("hello", true, 0));', [0, [true, ['hello', null]]])
})

test('Deterministic assignment', async () => {
  await testDeterministicCode('let a = 5; a = 10; a;', 10)
})
// ---------------------------------- Non deterministic code tests -------------------------------

test('Test simple amb application', async () => {
  await testNonDeterministicCode('amb(1, 4 + 5, 3 - 10);', [1, 9, -7])
})

test('Test if-else and conditional expressions', async () => {
  await testNonDeterministicCode('amb(false, true) ? 4 - 10 : 6;', [6, -6])
  await testNonDeterministicCode(
    `if (amb(true, false)) {
      -100;
     } else {
      200 / 2;
      210;
     }`,
    [-100, 210]
  )
  await testNonDeterministicCode(
    `if (amb(100 * 2 === 2, 40 % 2 === 0)) {
      amb(false, 'test' === 'test') ? amb(false === false, false) ? "hello" : false : amb(5, "world");
    } else {
      9 * 10 / 5;
    }`,
    [18, 5, 'world', 'hello', false]
  )
})

test('Test assignment', async () => {
  await testNonDeterministicCode('let a = amb(1, 2); a = amb(4, 5); a;', [4, 5, 4, 5])
})

// ---------------------------------- Helper functions  -------------------------------------------

const nonDetTestOptions = {
  scheduler: 'non-det',
  executionMethod: 'interpreter'
} as Partial<IOptions>

async function testDeterministicCode(code: string, expectedValue: any) {
  /* a deterministic program is equivalent to a non deterministic program
     that returns a single value */
  await testNonDeterministicCode(code, [expectedValue])
}

async function testNonDeterministicCode(code: string, expectedValues: any[]) {
  const context = makeNonDetContext()
  let result: Result = await runInContext(code, context, nonDetTestOptions)
  const numOfRuns = expectedValues.length
  for (let i = 0; i < numOfRuns; i++) {
    expect((result as SuspendedNonDet).value).toEqual(expectedValues[i])
    expect(result.status).toEqual('suspended-non-det')
    result = await resume(result)
  }

  // all non deterministic programs have a final result whose value is undefined
  expect(result.status).toEqual('finished')
  expect((result as Finished).value).toEqual(undefined)
}

function makeNonDetContext() {
  const context = mockContext(4)
  context.executionMethod = 'interpreter'
  return context
}
