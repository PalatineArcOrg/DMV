// Polyfills MUST be first import
import './src/polyfills';

import React, { useEffect, useState } from 'react';
import { StatusBar, View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ConnectionProvider } from './src/utils/ConnectionProvider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RootNavigator } from './src/navigation/RootNavigator';
import { initDatabase } from './src/db/database';
import { NotificationService } from './src/notifications/NotificationService';
import { useDemoStore } from './src/store/useDemoStore';
import { useHeartbeatStore } from './src/store/useHeartbeatStore';
import { getSetting } from './src/db/settingsRepo';
import { COLORS } from './src/utils/constants';

const queryClient = new QueryClient();

export default function App() {
  const [dbReady, setDbReady] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);

  useEffect(() => {
    initDatabase()
      .then(() => NotificationService.initialize())
      .then(async () => {
        await useDemoStore.getState().loadFromDb();
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

  if (!dbReady) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={COLORS.accent} />
      </View>
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
  errorText: {
    color: COLORS.critical,
    fontSize: 14,
  },
});
