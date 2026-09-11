import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

// Safe-by-default network stub. Any test that renders a real component
// wired to trackEvent() (or otherwise calls fetch) without mocking it
// itself would otherwise hit the real network - including production
// Mixpanel - once per test run. Tests that need to assert on fetch/analytics
// behavior (e.g. analytics.test.ts, WorkspaceEditor.test.tsx) call their own
// vi.stubGlobal('fetch', ...) afterward, which overrides this default.
vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))

// Node 24+ exposes an experimental global localStorage accessor that returns
// undefined unless the process was started with --localstorage-file. It can
// shadow jsdom's Storage object, so renderer tests always use this deterministic
// in-memory implementation.
const localStorageValues = new Map<string, string>()
const testLocalStorage: Storage = {
  get length() { return localStorageValues.size },
  clear: () => localStorageValues.clear(),
  getItem: key => localStorageValues.get(String(key)) ?? null,
  key: index => [...localStorageValues.keys()][index] ?? null,
  removeItem: key => { localStorageValues.delete(String(key)) },
  setItem: (key, value) => { localStorageValues.set(String(key), String(value)) }
}
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: testLocalStorage })

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
