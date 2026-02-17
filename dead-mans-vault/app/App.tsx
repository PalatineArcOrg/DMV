// Polyfills MUST be first import
import './src/polyfills';

import React, { useEffect, useState } from 'react';
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
import { COLORS, FONTS } from './src/utils/constants';

const queryClient = new QueryClient();

export default function App() {
  const [dbReady, setDbReady] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);

  const [fontsLoaded] = useFonts({
    SpaceGrotesk_400Regular,
    SpaceGrotesk_500Medium,
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
  });

  const isAuthEnabled = useAuthStore((s) => s.isAuthEnabled);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  useEffect(() => {
    initDatabase()
      .then(() => NotificationService.initialize())
      .then(async () => {
        await useDemoStore.getState().loadFromDb();
        await useAuthStore.getState().loadFromDb();
        const savedHbConfig = await getSetting('heartbeat_config');
        if (savedHbConfig) {
          try {
            useHeartbeatStore.getState().setConfig(JSON.parse(savedHbConfig));
          } catch {}
        }
      })
      .then(() => setDbReady(true))
      .catch((err) => setDbError(err.message));
  }, []);

  if (dbError) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Database error: {dbError}</Text>
      </View>
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
