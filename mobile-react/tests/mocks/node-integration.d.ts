declare module 'node:assert/strict' {
  interface StrictAssert {
    (value: unknown, message?: string): asserts value
    equal(actual: unknown, expected: unknown, message?: string): void
    strictEqual(actual: unknown, expected: unknown, message?: string): void
    notEqual(actual: unknown, expected: unknown, message?: string): void
    deepEqual(actual: unknown, expected: unknown, message?: string): void
    match(value: string, pattern: RegExp, message?: string): void
    rejects(
      promise: Promise<unknown>,
      expected?: RegExp | ((error: unknown) => boolean) | Record<string, unknown>,
      message?: string,
    ): Promise<void>
  }
  const assert: StrictAssert
  export default assert
}

declare module 'node:http' {
  export interface IncomingMessage {
    url?: string
    headers: Record<string, string | string[] | undefined>
  }
  export interface ServerResponse {
    destroyed: boolean
    writableEnded: boolean
    writeHead(status: number, headers: Record<string, string>): void
    end(value?: string): void
  }
  export interface Server {
    once(event: string, listener: (error?: unknown) => void): void
    off(event: string, listener: (error?: unknown) => void): void
    listen(port: number, host: string, listener: () => void): void
    address(): null | string | { port: number }
    close(listener: () => void): void
    closeAllConnections?(): void
  }
  export function createServer(listener: (request: IncomingMessage, response: ServerResponse) => void): Server
}
