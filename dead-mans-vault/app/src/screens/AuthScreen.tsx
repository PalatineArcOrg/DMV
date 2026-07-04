import React, { useEffect, useCallback, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useAuthStore } from '../store/useAuthStore';
import { BrandMark } from '../components/BrandMark';
import { COLORS, FONTS } from '../utils/constants';

export function AuthScreen() {
  const setAuthenticated = useAuthStore((s) => s.setAuthenticated);
  const [failed, setFailed] = useState(false);

  const authenticate = useCallback(async () => {
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();

      // If no hardware or not enrolled, auto-pass
      if (!hasHardware || !isEnrolled) {
        setAuthenticated(true);
        return;
      }

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock Dead Man\'s Vault',
        fallbackLabel: 'Use PIN',
      });

      if (result.success) {
        setAuthenticated(true);
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    }
  }, [setAuthenticated]);

  useEffect(() => {
    authenticate();
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.iconCircle}>
        <BrandMark size={44} />
      </View>
      <Text style={styles.title}>Dead Man's Vault</Text>
      <Text style={styles.subtitle}>Authenticate to continue</Text>

      {failed && (
        <TouchableOpacity style={styles.retryBtn} onPress={authenticate}>
          <MaterialCommunityIcons name="fingerprint" size={20} color={COLORS.bg} />
          <Text style={styles.retryText}>Try Again</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  iconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(0,255,163,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(0,255,163,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#FFFFFF',
    fontFamily: FONTS.primaryBold,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.5)',
    fontFamily: FONTS.primary,
    marginBottom: 32,
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.accent,
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 16,
  },
  retryText: {
    color: COLORS.bg,
    fontSize: 15,
    fontWeight: '700',
    fontFamily: FONTS.primaryBold,
  },
});
