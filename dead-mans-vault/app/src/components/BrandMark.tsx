import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';
import { COLORS } from '../utils/constants';

interface BrandMarkProps {
  size?: number;
  color?: string;
}

/**
 * The DMV brand mark — the ECG pulse in a circle, drawn from the brand SVG
 * sources in assets/brand/ (glyph-mint-transparent.svg). Used in logo
 * positions (auth gate, headers, hero states) instead of generic icon-font
 * shields, so the in-app identity matches the app icon / splash / website.
 */
export function BrandMark({ size = 40, color = COLORS.accent }: BrandMarkProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Circle cx="50" cy="50" r="30" fill="none" stroke={color} strokeWidth={7} />
      <Path
        d="M28 50 H36 L41 33 L48 67 L53 50 H72"
        fill="none"
        stroke={color}
        strokeWidth={7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
