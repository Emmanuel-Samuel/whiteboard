import type {
  ReviewCanvasUi,
  ReviewMenuRequest,
} from "@dev.fast/review-protocol";
import * as stylex from "@stylexjs/stylex";

import { menuStyles as styles } from "./web-styles";

/** A DOM menu for hosts that pass no `ui`, placed inside the canvas theme host so its styles apply. */
export function webCanvasUi(): ReviewCanvasUi {
  return {
    showMenu(request: ReviewMenuRequest) {
      const { anchor } = request;
      const doc = anchor.ownerDocument;
      const menu = doc.createElement("div");
      menu.setAttribute("role", "menu");
      menu.popover = "manual";
      menu.className = stylex.props(styles.menu).className ?? "";
      let closed = false;

      const close = () => {
        if (closed) return;
        closed = true;
        doc.removeEventListener("pointerdown", onPointerDown, true);
        anchor.removeEventListener("click", close);
        menu.remove();
        request.onHide();
      };

      const items = request.items.map((item) => {
        const button = doc.createElement("button");
        button.type = "button";
        button.disabled = item.enabled === false;
        button.className = stylex.props(styles.item).className ?? "";
        button.setAttribute(
          "role",
          item.checked === undefined ? "menuitem" : "menuitemcheckbox",
        );

        if (item.checked !== undefined)
          button.setAttribute("aria-checked", String(item.checked));

        const check = doc.createElement("span");
        check.className = stylex.props(styles.check).className ?? "";
        check.textContent = item.checked ? "✓" : "";
        button.append(check, item.label);
        button.addEventListener("click", () => {
          close();
          void request.onSelect(item.id);
        });

        return button;
      });

      const onPointerDown = (event: PointerEvent) => {
        const { target } = event;

        if (
          !(target instanceof Node) ||
          (!menu.contains(target) && !anchor.contains(target))
        )
          close();
      };

      menu.addEventListener("keydown", (event) => {
        const enabled = items.filter((item) => !item.disabled);
        const at = enabled.findIndex((item) => item === doc.activeElement);

        if (event.key === "Escape") {
          event.preventDefault();
          close();
          anchor.focus();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          enabled.at((at + step) % enabled.length)?.focus();
        }
      });

      menu.append(...items);
      (anchor.closest(".review-canvas-root > *") ?? doc.body).append(menu);
      menu.showPopover();

      const rect = anchor.getBoundingClientRect();
      const width = menu.offsetWidth;
      menu.style.top = `${rect.bottom + 4}px`;
      menu.style.left = `${Math.max(4, Math.min(rect.left, doc.documentElement.clientWidth - width - 4))}px`;

      doc.addEventListener("pointerdown", onPointerDown, true);
      anchor.addEventListener("click", close);
      items.find((item) => !item.disabled)?.focus();

      return { dispose: close };
    },
  };
}
