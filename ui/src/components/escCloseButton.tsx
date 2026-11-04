import { CloseIcon } from "@mantine/core"
import { KeyHint } from "./search/KeyHint"

/**
 * Props for a close button that says Esc closes it too. The size is fixed
 * because the icon's default is a percentage of the button, which is as wide
 * as its contents here. See .esc-close in styles/theme.css.
 */
export const escCloseButtonProps = {
  className: "esc-close",
  icon: (
    <>
      <CloseIcon size="20px" />
      <span className="esc-close-hint">
        <KeyHint decorative>Esc</KeyHint>
      </span>
    </>
  ),
}
