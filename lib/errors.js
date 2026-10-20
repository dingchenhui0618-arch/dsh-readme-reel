// Shared error type. Every user-facing failure of this plugin is one sentence
// with this prefix, so the panel, the CLI and the tests can assert on the same
// contract instead of guessing at Error internals.
export class ReelError extends Error {
  constructor(message) {
    super('[dsh-readme-reel] ' + message)
    this.name = 'ReelError'
  }
}

export function reelError(message) {
  return new ReelError(message)
}
