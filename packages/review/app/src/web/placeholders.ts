import type {
  ReviewDiffViewFactory,
  ReviewInlineEditorFactory,
} from "@dev.fast/review-protocol";

export function placeholderInlineEditors(): ReviewInlineEditorFactory {
  return {
    async find() {
      return { matchCount: 0 };
    },
    create: (spec) => {
      const editor = document.createElement("div");
      editor.className = "fixture-inline-editor";
      editor.dataset.path = spec.path;
      spec.container.appendChild(editor);

      return {
        height: 180,
        setActive() {},
        setCollapsed() {},
        async setFindQuery() {
          return { matchCount: 0 };
        },
        revealFindMatch() {},
        clearActiveFindMatch() {},
        clearFind() {},
        onDidChangeHeight: () => ({ dispose() {} }),
        onDidError: () => ({ dispose() {} }),
        dispose: () => {
          editor.remove();
        },
      };
    },
  };
}

export function placeholderDiffView(): ReviewDiffViewFactory {
  return {
    files: async () => [],
    create: () => {
      throw new Error("Diff is not available in a shared view yet.");
    },
  };
}
