import { type ThemedToken, getSharedHighlighter } from "@pierre/diffs";

const languages = new Map(
  Object.entries({
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    py: "python",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    rb: "ruby",
    sh: "shellscript",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sql: "sql",
    c: "c",
    cpp: "cpp",
    h: "c",
    cs: "csharp",
  }),
);

const cache = new Map<string, Promise<ThemedToken[][] | undefined>>();

function languageFor(path: string): string | undefined {
  const extension = /\.([^./]+)$/.exec(path)?.[1];

  return extension && languages.get(extension.toLowerCase());
}

export function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.reviewTheme === "light"
    ? "light"
    : "dark";
}

export function highlight(
  path: string,
  commit: string,
  text: string,
): Promise<ThemedToken[][] | undefined> {
  const lang = languageFor(path);

  if (!lang) return Promise.resolve(undefined);

  const theme = currentTheme() === "light" ? "pierre-light" : "pierre-dark";

  const key = `${theme}\0${commit}\0${path}`;
  let tokens = cache.get(key);

  if (!tokens) {
    tokens = getSharedHighlighter({ themes: [theme], langs: [lang] })
      .then(
        (highlighter) => highlighter.codeToTokens(text, { lang, theme }).tokens,
      )
      .catch(() => undefined);
    cache.set(key, tokens);
  }

  return tokens;
}
