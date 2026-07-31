// Polyfills MUST be first import
import './src/polyfills';

import React, { useEffect, useState, useCallback } from 'react';
import { StatusBar, View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  useFonts,
  SpaceGrotesk_400Regular,
  SpaceGrotesk_500Medium,
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
} from '@expo-google-fonts/space-grotesk';
import { ConnectionProvider } from './src/utils/ConnectionProvider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RootNavigator } from './src/navigation/RootNavigator';
import { AuthScreen } from './src/screens/AuthScreen';
import { initDatabase } from './src/db/database';
import { NotificationService } from './src/notifications/NotificationService';
import { useDemoStore } from './src/store/useDemoStore';
import { useHeartbeatStore } from './src/store/useHeartbeatStore';
import { useAuthStore } from './src/store/useAuthStore';
import { getSetting } from './src/db/settingsRepo';
import { loadRpcOverride, verifyNetwork, type NetworkVerification } from './src/utils/rpcConfig';
import { useNetworkStore } from './src/store/useNetworkStore';
import { NetworkGateScreen } from './src/screens/NetworkGateScreen';
import { COLORS, FONTS } from './src/utils/constants';
import { BuildIdentityBanner } from './src/components/BuildIdentityBanner';

const queryClient = new QueryClient();

export default function App() {
  const [dbReady, setDbReady] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [netVerification, setNetVerification] = useState<NetworkVerification | null>(null);
  const [netBusy, setNetBusy] = useState(false);

  const [fontsLoaded] = useFonts({
    SpaceGrotesk_400Regular,
    SpaceGrotesk_500Medium,
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
  });

  const isAuthEnabled = useAuthStore((s) => s.isAuthEnabled);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const bootstrap = useCallback(async (allowUnknown: boolean) => {
    try {
      setDbError(null);
      setNetBusy(true);
      await initDatabase();
      // Load any custom-RPC override BEFORE the first Connection is created
      // (ConnectionProvider mounts only after dbReady, below).
      await loadRpcOverride(getSetting);
      // Fail-closed network gate: verify the RPC's genesis hash matches this build's
      // expected cluster. MISMATCH hard-blocks here (dbReady never set → ConnectionProvider
      // never mounts). UNKNOWN waits for the user to retry or explicitly continue.
      const verification = await verifyNetwork();
      useNetworkStore.getState().setVerification(verification);
      setNetVerification(verification);
      if (verification.state === 'MISMATCH') return;
      if (verification.state === 'UNKNOWN' && !allowUnknown) return;
      await NotificationService.initialize();
      await useDemoStore.getState().loadFromDb();
      await useAuthStore.getState().loadFromDb();
      const savedHbConfig = await getSetting('heartbeat_config');
      if (savedHbConfig) {
        try {
          useHeartbeatStore.getState().setConfig(JSON.parse(savedHbConfig));
        } catch {}
      }
      setDbReady(true);
    } catch (err: any) {
      setDbError(err?.message ?? String(err));
    } finally {
      setNetBusy(false);
    }
  }, []);

  useEffect(() => {
    bootstrap(false);
  }, [bootstrap]);

  if (dbError) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Database error: {dbError}</Text>
      </View>
    );
  }

  // Fail-closed network gate. MISMATCH is always blocked (no continue). UNKNOWN offers a
  // retry, or an explicit continue into a session the store still marks UNKNOWN (future
  // write-gating, T1.3, no-ops writes there). VERIFIED falls through to the normal boot.
  if (
    netVerification &&
    (netVerification.state === 'MISMATCH' ||
      (netVerification.state === 'UNKNOWN' && !dbReady))
  ) {
    return (
      <NetworkGateScreen
        verification={netVerification}
        onRetry={() => bootstrap(false)}
        onContinue={netVerification.state === 'UNKNOWN' ? () => bootstrap(true) : undefined}
        busy={netBusy}
      />
    );
  }

  if (!dbReady || !fontsLoaded) {
    return (
      <View style={styles.center}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={COLORS.accent} />
          <Text style={styles.loadingText}>Loading...</Text>
        </View>
      </View>
    );
  }

  // Auth gate: if auth is enabled but not authenticated, show auth screen
  if (isAuthEnabled && !isAuthenticated) {
    return (
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" backgroundColor={COLORS.bg} />
        <AuthScreen />
      </SafeAreaProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider config={{ commitment: 'confirmed' }}>
        <SafeAreaProvider>
          <StatusBar barStyle="light-content" backgroundColor={COLORS.bg} />
          <BuildIdentityBanner />
          <RootNavigator />
        </SafeAreaProvider>
      </ConnectionProvider>
    </QueryClientProvider>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.bg,
  },
  loadingContainer: {
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    color: 'rgba(255,255,255,0.35)',
    fontSize: 13,
    fontFamily: FONTS.primary,
  },
  errorText: {
    color: COLORS.critical,
    fontSize: 14,
    fontFamily: FONTS.primary,
  },
});
