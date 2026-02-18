import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';

interface EcgLineProps {
  width: number;
  height: number;
  color: string;
  speed: number; // ms per cycle, 0 = static flatline
  strokeWidth?: number;
}

// One EKG segment (200px wide): flat → P-wave → QRS complex → T-wave → flat
const SEGMENT_WIDTH = 200;
const buildEkgPath = (offsetX: number, h: number): string => {
  const cy = h / 2; // center y
  const scale = h / 50; // scale factor (designed for 50px height)
  const x = (v: number) => offsetX + v;
  const y = (v: number) => v * scale;

  return [
    `M${x(0)},${y(25)}`,
    `L${x(40)},${y(25)}`,       // flat
    `L${x(43)},${y(22)}`,       // P-wave up
    `L${x(48)},${y(25)}`,       // P-wave down
    `L${x(55)},${y(25)}`,       // flat
    `L${x(57)},${y(28)}`,       // Q dip
    `L${x(60)},${y(5)}`,        // R spike (big peak)
    `L${x(63)},${y(40)}`,       // S dip
    `L${x(66)},${y(25)}`,       // return to baseline
    `L${x(75)},${y(25)}`,       // flat
    `L${x(78)},${y(20)}`,       // T-wave up
    `L${x(85)},${y(25)}`,       // T-wave down
    `L${x(SEGMENT_WIDTH)},${y(25)}`, // flat to end
  ].join(' ');
};

const buildFlatlinePath = (totalWidth: number, h: number): string => {
  const cy = h / 2;
  return `M0,${cy} L${totalWidth},${cy}`;
};

export function EcgLine({ width, height, color, speed, strokeWidth = 2 }: EcgLineProps) {
  const translateX = useRef(new Animated.Value(0)).current;

  // Total SVG width = 3 segments (so we can scroll one full segment and reset seamlessly)
  const totalWidth = SEGMENT_WIDTH * 3;
  const isFlatline = speed === 0;

  useEffect(() => {
    if (isFlatline) {
      translateX.setValue(0);
      return;
    }

    const animation = Animated.loop(
      Animated.timing(translateX, {
        toValue: -SEGMENT_WIDTH,
        duration: speed,
        useNativeDriver: true,
        // Linear movement for smooth scrolling
        easing: (t) => t,
      }),
    );

    animation.start();
    return () => animation.stop();
  }, [speed, isFlatline]);

  // Build path: 3 repeating EKG segments
  const pathData = isFlatline
    ? buildFlatlinePath(width, height)
    : [0, 1, 2].map((i) => buildEkgPath(i * SEGMENT_WIDTH, height)).join(' ');

  return (
    <View style={[styles.container, { width, height }]}>
      <Animated.View
        style={[
          styles.inner,
          {
            width: isFlatline ? width : totalWidth,
            height,
            transform: isFlatline ? [] : [{ translateX }],
          },
        ]}
      >
        <Svg
          width={isFlatline ? width : totalWidth}
          height={height}
          viewBox={`0 0 ${isFlatline ? width : totalWidth} ${height}`}
        >
          <Path
            d={pathData}
            stroke={color}
            strokeWidth={strokeWidth}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  inner: {
    // Will be animated via translateX
  },
});
