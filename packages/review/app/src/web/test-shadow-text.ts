/** Text of `element` including the shadow roots of its descendants. */
export function shadowText(element: Element): string {
  return (
    (element.textContent ?? "") +
    [...element.querySelectorAll("*")]
      .map((child) => child.shadowRoot?.textContent ?? "")
      .join("")
  );
}
