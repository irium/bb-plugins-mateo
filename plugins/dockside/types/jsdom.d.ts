/**
 * jsdom ships no types of its own. `@types/jsdom` is hoisted into the root
 * node_modules by a sibling plugin and does not survive this plugin's
 * `skipLibCheck: false`, so tsconfig maps `jsdom` here instead. The tests only
 * need the constructor and its window, and the strict check stays on.
 */
export interface ConstructorOptions {
  pretendToBeVisual?: boolean;
  url?: string;
}

export declare class JSDOM {
  constructor(html?: string, options?: ConstructorOptions);
  readonly window: Window & typeof globalThis;
}
