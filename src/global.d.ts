import type { GigaCenterApi } from '@shared/ipc-types'

declare global {
  interface Window {
    gigacenter: GigaCenterApi & {
      filePathFor(file: File): string
    }
  }
}

export {}
