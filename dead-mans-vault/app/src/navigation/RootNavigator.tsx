import React, { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { DashboardScreen } from '../screens/DashboardScreen';
import { ExecutionLogsScreen } from '../screens/ExecutionLogsScreen';
import { ExecutionDetailScreen } from '../screens/ExecutionDetailScreen';
import { SetupWizardScreen } from '../screens/SetupWizardScreen';
import { WelcomeScreen } from '../screens/WelcomeScreen';
import { HeartbeatConfigScreen } from '../screens/HeartbeatConfigScreen';
import { BeneficiaryScreen } from '../screens/BeneficiaryScreen';
import { DeFiPositionsScreen } from '../screens/DeFiPositionsScreen';
import { EstateReviewScreen } from '../screens/EstateReviewScreen';
import { AssetsScreen } from '../screens/AssetsScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { useWallet } from '../hooks/useWallet';
import { useVaultStore } from '../store/useVaultStore';
import { useHeartbeatStore } from '../store/useHeartbeatStore';
import { useEscalationStore } from '../store/useEscalationStore';
import { COLORS, FONTS } from '../utils/constants';

const Tab = createBottomTabNavigator();
const DashboardStack = createNativeStackNavigator();
const AssetsStack = createNativeStackNavigator();
const SetupStack = createNativeStackNavigator();

const STACK_SCREEN_OPTIONS = {
  headerStyle: { backgroundColor: COLORS.bg },
  headerTintColor: '#FFFFFF',
  headerTitleStyle: { fontFamily: FONTS.primarySemiBold, fontSize: 16 },
  headerShadowVisible: false,
};

function DashboardStackScreen() {
  return (
    <DashboardStack.Navigator screenOptions={STACK_SCREEN_OPTIONS}>
      <DashboardStack.Screen
        name="Dashboard"
        component={DashboardScreen}
        options={{ headerShown: false }}
      />
      <DashboardStack.Screen
        name="ExecutionLogs"
        component={ExecutionLogsScreen}
        options={{ title: 'Execution Logs' }}
      />
      <DashboardStack.Screen
        name="ExecutionDetail"
        component={ExecutionDetailScreen}
        options={{ title: 'Execution Detail' }}
      />
    </DashboardStack.Navigator>
  );
}

function AssetsStackScreen() {
  return (
    <AssetsStack.Navigator screenOptions={STACK_SCREEN_OPTIONS}>
      <AssetsStack.Screen
        name="AssetsOverview"
        component={AssetsScreen}
        options={{ headerShown: false }}
      />
    </AssetsStack.Navigator>
  );
}

function SetupStackScreen() {
  return (
    <SetupStack.Navigator screenOptions={STACK_SCREEN_OPTIONS}>
      <SetupStack.Screen
        name="SetupWizard"
        component={SetupWizardScreen}
        options={{ title: 'Vault' }}
      />
      <SetupStack.Screen
        name="Welcome"
        component={WelcomeScreen}
        options={{ headerShown: false }}
      />
      <SetupStack.Screen
        name="HeartbeatConfig"
        component={HeartbeatConfigScreen}
        options={{ title: 'Heartbeat' }}
      />
      <SetupStack.Screen
        name="Beneficiaries"
        component={BeneficiaryScreen}
        options={{ title: 'Beneficiaries' }}
      />
      <SetupStack.Screen
        name="DeFiPositions"
        component={DeFiPositionsScreen}
        options={{ title: 'DeFi Positions' }}
      />
      <SetupStack.Screen
        name="EstateReview"
        component={EstateReviewScreen}
        options={{ title: 'Review' }}
      />
    </SetupStack.Navigator>
  );
}

type TabIconName = 'view-dashboard' | 'wallet' | 'text-box-outline' | 'cog';

const TAB_ICONS: Record<string, TabIconName> = {
  Status: 'view-dashboard',
  Assets: 'wallet',
  Vault: 'text-box-outline',
  Settings: 'cog',
};

const DMVDarkTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: COLORS.bg,
    card: COLORS.bg,
    text: '#FFFFFF',
    border: 'rgba(255,255,255,0.07)',
    primary: COLORS.accent,
  },
};

export function RootNavigator() {
  const { publicKey, connected, signAndSendTransaction } = useWallet();
  const prevPkRef = useRef(publicKey?.toBase58() ?? '');
  const migrationCheckedRef = useRef(false);

  // Global wallet-change detection — resets all stores on disconnect or wallet switch
  useEffect(() => {
    const currentKey = publicKey?.toBase58() ?? '';

    if (!connected || !currentKey) {
      // Wallet disconnected — clear everything
      if (prevPkRef.current) {
        useVaultStore.getState().resetForWalletSwitch();
        useHeartbeatStore.getState().reset();
        useEscalationStore.getState().reset();
        migrationCheckedRef.current = false;
      }
      prevPkRef.current = '';
      return;
    }

    if (prevPkRef.current && prevPkRef.current !== currentKey) {
      // Switched to a different wallet — reset then fetch new vault
      useVaultStore.getState().resetForWalletSwitch();
      useHeartbeatStore.getState().reset();
      useEscalationStore.getState().reset();
      migrationCheckedRef.current = false;
    }

    // Fetch vault config for the connected wallet
    if (prevPkRef.current !== currentKey || !useVaultStore.getState().vaultConfig) {
      (async () => {
        try {
          const { VaultTransactionService } = require('../services/VaultTransactionService');
          const txService = new VaultTransactionService();
          const vault = await txService.fetchVaultConfig(publicKey!);
          if (vault) {
            useVaultStore.getState().setVaultConfig(vault);
          }

          // Check for device migration need (missing/mismatched agent key)
          if (!migrationCheckedRef.current && vault && vault.active && !vault.executed) {
            migrationCheckedRef.current = true;

            // Skip for freshly created vaults (< 2 min old)
            const createdAt = vault.createdAt?.toNumber?.() ?? 0;
            const ageSeconds = Math.floor(Date.now() / 1000) - createdAt;
            if (ageSeconds > 120) {
              const { KeyManager } = require('../tee/KeyManager');
              const keyManager = KeyManager.getInstance();
              const hasKey = await keyManager.hasAgentKey();
              let needsRotation = false;

              if (!hasKey) {
                needsRotation = true;
              } else {
                const localPubkey = await keyManager.getAgentPublicKey();
                const onChainAgent = vault.agentPubkey?.toBase58?.() ?? '';
                needsRotation = localPubkey !== onChainAgent;
              }

              if (needsRotation) {
                const { MigrationService } = require('../services/MigrationService');
                Alert.alert(
                  'Device Migration Required',
                  'Your vault\'s agent key does not match this device. Heartbeats will fail until you rotate the agent key.\n\nWould you like to rotate it now? Your wallet signature is required.',
                  [
                    { text: 'Later', style: 'cancel' },
                    {
                      text: 'Rotate Now',
                      onPress: async () => {
                        try {
                          await MigrationService.executeRotation(publicKey!, signAndSendTransaction);
                          Alert.alert('Migration Complete', 'Agent key rotated successfully. Heartbeats will resume.');
                        } catch {
                          Alert.alert('Rotation Failed', 'Could not rotate agent key. Please try again from Settings.');
                        }
                      },
                    },
                  ],
                );
              }
            }
          }
        } catch {}
      })();
    }

    prevPkRef.current = currentKey;
  }, [connected, publicKey]);

  return (
    <NavigationContainer theme={DMVDarkTheme}>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarStyle: {
            backgroundColor: 'rgba(7,9,15,0.95)',
            borderTopWidth: 1,
            borderTopColor: 'rgba(255,255,255,0.06)',
            paddingTop: 6,
            height: 60,
          },
          tabBarActiveTintColor: COLORS.accent,
          tabBarInactiveTintColor: 'rgba(255,255,255,0.35)',
          tabBarLabelStyle: {
            fontFamily: FONTS.primarySemiBold,
            fontSize: 10,
            fontWeight: '600',
          },
          tabBarIcon: ({ color, size }) => {
            const iconName = TAB_ICONS[route.name] ?? 'circle';
            return (
              <MaterialCommunityIcons name={iconName} size={size ?? 22} color={color} />
            );
          },
        })}
      >
        <Tab.Screen name="Status" component={DashboardStackScreen} />
        <Tab.Screen name="Assets" component={AssetsStackScreen} />
        <Tab.Screen name="Vault" component={SetupStackScreen} />
        <Tab.Screen name="Settings" component={SettingsScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
