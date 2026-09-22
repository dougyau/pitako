import { AsyncLocalStorage } from "node:async_hooks";

const authors = new AsyncLocalStorage<string>();

/** Main session author. AgentInstance runs replace this for their own calls. */
export const DEFAULT_BOARD_AUTHOR = "pi";

export function currentBoardAuthor(): string {
  return authors.getStore() ?? DEFAULT_BOARD_AUTHOR;
}

export function withBoardAuthor<T>(author: string, run: () => T): T {
  return authors.run(author, run);
}
