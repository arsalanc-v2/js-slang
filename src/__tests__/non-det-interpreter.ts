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
// ---------------------------------- Non deterministic code tests -------------------------------

test('Test simple amb application', async () => {
  await testNonDeterministicCode('amb(1, 4 + 5, 3 - 10);', [1, 9, -7])
})

// ---------------------------------- Helper functions  -------------------------------------------

const nonDetTestOptions = {
  scheduler: 'preemptive',
  executionMethod: 'non-det-interpreter'
} as Partial<IOptions>

async function testDeterministicCode(code: string, expectedValue: any) {
  /* a deterministic program is equivalent to a non deterministic program
     that returns a single value */
  testNonDeterministicCode(code, [expectedValue])
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

test('Test conditional expression', async () => {
  const context = makeNonDetContext()
  let result = await runInContext('amb(false, true) ? 4 : 6;', context, nonDetTestOptions)
  expect(result.status).toBe('suspended-non-det')
  expect((result as SuspendedNonDet).value).toBe(6)
  result = await resume(result)
  expect(result.status).toBe('suspended-non-det')
  expect((result as SuspendedNonDet).value).toBe(4)

  result = await resume(result)
  expect(result.status).toBe('finished')
  expect((result as Finished).value).toBe(undefined)
})

function makeNonDetContext() {
  const context = mockContext(4)
  context.executionMethod = 'non-det-interpreter'
  return context
}
