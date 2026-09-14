"use client";

import { RotateCcw } from "lucide-react";

export type ViewerControlIconProps = {
  size?: number;
  strokeWidth?: number;
  "aria-hidden"?: boolean | "true" | "false";
};

export function ResetZoomIcon({ strokeWidth = 1.65, "aria-hidden": ariaHidden = true }: ViewerControlIconProps) {
  return (
    <span className="reset-zoom-symbol" aria-hidden={ariaHidden}>
      <RotateCcw size={17} strokeWidth={strokeWidth} />
    </span>
  );
}
