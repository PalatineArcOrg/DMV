import React, { useEffect, useState } from 'react';
import { Text, TouchableOpacity, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useRpcStatusStore } from '../store/useRpcStatusStore';
import { COLORS, FONTS } from '../utils/constants';

// How long the banner lingers after the last rate-limit before auto-hiding.
const VISIBLE_MS = 12_000;

/**
 * Thin warning bar shown when the app is being rate-limited (RPC/DAS/API 429).
 * Tapping opens Settings so the user can add their own RPC. Auto-hides once traffic
 * settles. Render near the top of a scroll view (Dashboard, Assets).
 */
export function RpcStatusBanner() {
  const lastRateLimitAt = useRpcStatusStore((s) => s.lastRateLimitAt);
  const navigation = useNavigation<any>();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!lastRateLimitAt) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), VISIBLE_MS);
    return () => clearTimeout(t);
  }, [lastRateLimitAt]);

  if (!visible) return null;

  return (
    <TouchableOpacity
      style={styles.banner}
      activeOpacity={0.8}
      onPress={() => navigation.getParent()?.navigate('Settings')}
    >
      <MaterialCommunityIcons name="wifi-alert" size={15} color={COLORS.warning} />
      <Text style={styles.text} numberOfLines={2}>
        Network busy — data may be delayed by rate limits. Tap to use your own RPC.
      </Text>
      <MaterialCommunityIcons name="chevron-right" size={16} color={COLORS.warning} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(245,158,11,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.35)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginHorizontal: 16,
    marginTop: 10,
  },
  text: {
    flex: 1,
    color: COLORS.warning,
    fontSize: 12,
    fontFamily: FONTS.primary,
  },
});
