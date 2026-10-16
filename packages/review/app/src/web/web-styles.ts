import { elevation, fontSize, radius } from "@canvas/scale.stylex";
import { tokens } from "@canvas/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

export const peekStyles = stylex.create({
  peek: {
    position: "relative",
    overflow: "auto",
    paddingBlock: "6px",
    borderRadius: radius.small,
    backgroundColor: tokens.surface,
    color: tokens.ink,
    fontFamily: tokens.fontMono,
    fontSize: fontSize.body,
    lineHeight: "18px",
  },
  capped: {
    maxHeight: "420px",
  },
  active: {
    outlineWidth: "1px",
    outlineStyle: "solid",
    outlineColor: tokens.accentOutline,
  },
  collapsed: {
    display: "none",
  },
  range: {
    borderTopWidth: {
      default: "1px",
      ":first-child": "0",
    },
    borderTopStyle: "dashed",
    borderTopColor: tokens.ruleSoft,
  },
  line: {
    display: "flex",
    width: "max-content",
    minWidth: "100%",
    whiteSpace: "pre",
  },
  gutter: {
    flexShrink: 0,
    minWidth: "4ch",
    paddingInline: "8px 12px",
    color: tokens.inkFaint,
    textAlign: "right",
    userSelect: "none",
  },
  code: {
    paddingInlineEnd: "12px",
  },
  match: {
    borderRadius: radius.hairline,
    backgroundColor: tokens.reviewFindMatchBackground,
    color: "inherit",
  },
  activeMatch: {
    backgroundColor: tokens.reviewFindMatchActiveBackground,
  },
  sideLabel: {
    paddingInline: "12px",
    color: tokens.inkFaint,
    fontFamily: tokens.chromeFont,
    fontSize: fontSize.small,
  },
  notice: {
    paddingInline: "12px",
    color: tokens.inkMuted,
    fontFamily: tokens.chromeFont,
  },
});

export const diffStyles = stylex.create({
  scroller: {
    "--diffs-font-family": tokens.fontMono,
    height: "100%",
    overflow: "auto",
    outline: "none",
  },
  binary: {
    paddingBlock: "8px",
    paddingInline: "12px",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: tokens.ruleSoft,
    color: tokens.inkMuted,
    fontFamily: tokens.fontMono,
    fontSize: fontSize.body,
  },
  tree: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    fontFamily: tokens.chromeFont,
    fontSize: fontSize.body,
  },
  treeItem: {
    display: "flex",
    width: "100%",
    borderWidth: 0,
    font: "inherit",
    textAlign: "left",
    gap: "8px",
    paddingBlock: "2px",
    paddingInline: "8px",
    color: tokens.ink,
    cursor: "pointer",
    backgroundColor: { default: "transparent", ":hover": tokens.surface },
  },
  treeMissing: {
    color: tokens.inkFaint,
    cursor: "default",
    backgroundColor: "transparent",
  },
  treePath: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  treeCounts: {
    flexShrink: 0,
    color: tokens.inkFaint,
  },
  fallbackTag: {
    flexShrink: 0,
    paddingInline: "6px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.warningOutline,
    borderRadius: radius.pill,
    backgroundColor: tokens.warningWash,
    color: tokens.ink,
    fontFamily: tokens.chromeFont,
    fontSize: fontSize.small,
  },
});

export const menuStyles = stylex.create({
  menu: {
    position: "fixed",
    inset: "auto",
    display: "flex",
    flexDirection: "column",
    minWidth: "160px",
    margin: 0,
    padding: "4px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.chromeBorder,
    borderRadius: radius.surface,
    backgroundColor: tokens.surfaceRaised,
    color: tokens.chromeFg,
    boxShadow: elevation.popover,
    fontFamily: tokens.chromeFont,
    fontSize: tokens.chromeFontSize,
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    borderWidth: 0,
    borderRadius: radius.small,
    paddingBlock: "4px",
    paddingInline: "8px",
    font: "inherit",
    textAlign: "left",
    color: { default: "inherit", ":disabled": tokens.inkFaint },
    cursor: { default: "pointer", ":disabled": "default" },
    backgroundColor: {
      default: "transparent",
      ":hover:enabled": tokens.chromeHoverBg,
      ":focus-visible": tokens.chromeHoverBg,
    },
    outline: "none",
  },
  check: {
    width: "1em",
  },
});
