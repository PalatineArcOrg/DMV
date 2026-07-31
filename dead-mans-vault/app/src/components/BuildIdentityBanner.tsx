import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  getRuntimeBuildIdentity,
  getRuntimeIdentityPolicy,
} from '../config/runtimeIdentity';
import { COLORS, FONTS } from '../utils/constants';

export function BuildIdentityBanner() {
  const identity = getRuntimeBuildIdentity();
  const policy = getRuntimeIdentityPolicy(identity);
  return (
    <View
      style={[
        styles.banner,
        policy.privateBridge ? styles.bridge : styles.successor,
      ]}
    >
      <Text style={styles.text}>
        {policy.privateBridge
          ? 'PRIVATE DEVNET LEGACY BRIDGE — RETAIN FOR ROLLBACK'
          : 'DEVNET SUCCESSOR — MIGRATION MODE'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    alignItems: 'center',
  },
  bridge: { backgroundColor: COLORS.warning },
  successor: { backgroundColor: COLORS.solanaPurple },
  text: {
    color: COLORS.bg,
    fontFamily: FONTS.primarySemiBold,
    fontSize: 10,
    letterSpacing: 0.7,
  },
});
