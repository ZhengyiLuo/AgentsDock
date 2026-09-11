import { SerialWorkQueue } from './serial-work-queue'

function assertStarted(actual: number[], expected: number[], message: string): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${message}: expected ${expected.join(',')}, received ${actual.join(',')}`)
  }
}

const queue = new SerialWorkQueue()
const started: number[] = []
const finishes: Array<() => void> = []
const cancelFirst = queue.enqueue(finish => { started.push(1); finishes.push(finish) })
const cancelSecond = queue.enqueue(finish => { started.push(2); finishes.push(finish) })
const cancelThird = queue.enqueue(finish => { started.push(3); finishes.push(finish) })

assertStarted(started, [1], 'only one queued job may start at a time')
cancelSecond()
finishes[0]()
assertStarted(started, [1, 3], 'a cancelled waiting job must never start')
finishes[1]()
assertStarted(started, [1, 3], 'finishing the final job must leave the queue idle')

cancelFirst()
cancelThird()
console.log('serial work queue tests passed')
