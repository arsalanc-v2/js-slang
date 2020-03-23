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
    expect((result as SuspendedNonDet).value).toBe(expectedValues[i])
    expect(result.status).toBe('suspended-non-det')
    result = await resume(result)
  }

  // all non deterministic programs have a final result whose value is undefined
  expect(result.status).toBe('finished')
  expect((result as Finished).value).toBe(undefined)
}

function makeNonDetContext() {
  const context = mockContext(4)
  context.executionMethod = 'interpreter'
  return context
}
