import type { WebTheme, WebThemeName } from "./highlight";

export function testTheme(initial: WebThemeName = "dark") {
  let current = initial;
  const listeners = new Set<(theme: WebThemeName) => void>();

  const theme: WebTheme = {
    theme: () => current,
    onDidChangeTheme(listener) {
      listeners.add(listener);

      return { dispose: () => listeners.delete(listener) };
    },
  };

  return {
    theme,
    listeners,
    set(next: WebThemeName) {
      current = next;

      for (const listener of listeners) listener(next);
    },
  };
}
