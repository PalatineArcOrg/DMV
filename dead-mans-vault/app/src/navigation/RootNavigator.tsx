import React from 'react';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { MaterialIcons } from '@expo/vector-icons';
import { DashboardScreen } from '../screens/DashboardScreen';
import { ExecutionLogScreen } from '../screens/ExecutionLogScreen';
import { SetupWizardScreen } from '../screens/SetupWizardScreen';
import { WelcomeScreen } from '../screens/WelcomeScreen';
import { HeartbeatConfigScreen } from '../screens/HeartbeatConfigScreen';
import { BeneficiaryScreen } from '../screens/BeneficiaryScreen';
import { DeFiPositionsScreen } from '../screens/DeFiPositionsScreen';
import { EstateReviewScreen } from '../screens/EstateReviewScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { COLORS } from '../utils/constants';

const Tab = createBottomTabNavigator();
const DashboardStack = createNativeStackNavigator();
const SetupStack = createNativeStackNavigator();

function DashboardStackScreen() {
  return (
    <DashboardStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: COLORS.bg },
        headerTintColor: COLORS.textPrimary,
      }}
    >
      <DashboardStack.Screen
        name="Dashboard"
        component={DashboardScreen}
        options={{ title: 'Dead Man\'s Vault' }}
      />
      <DashboardStack.Screen
        name="ExecutionLog"
        component={ExecutionLogScreen}
        options={{ title: 'Execution Log' }}
      />
    </DashboardStack.Navigator>
  );
}

function SetupStackScreen() {
  return (
    <SetupStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: COLORS.bg },
        headerTintColor: COLORS.textPrimary,
      }}
    >
      <SetupStack.Screen
        name="SetupWizard"
        component={SetupWizardScreen}
        options={{ title: 'Setup' }}
      />
      <SetupStack.Screen
        name="Welcome"
        component={WelcomeScreen}
        options={{ title: 'Welcome' }}
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

const TAB_ICONS: Record<string, keyof typeof MaterialIcons.glyphMap> = {
  Status: 'dashboard',
  Setup: 'shield',
  Settings: 'settings',
};

const DMVDarkTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: COLORS.bg,
    card: COLORS.bg,
    text: COLORS.textPrimary,
    border: COLORS.border,
    primary: COLORS.accent,
  },
};

export function RootNavigator() {
  return (
    <NavigationContainer theme={DMVDarkTheme}>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarStyle: {
            backgroundColor: COLORS.bg,
            borderTopColor: COLORS.border,
          },
          tabBarActiveTintColor: COLORS.accent,
          tabBarInactiveTintColor: COLORS.textMuted,
          tabBarIcon: ({ focused, color, size }) => {
            const iconName = TAB_ICONS[route.name] ?? 'circle';
            return (
              <MaterialIcons name={iconName} size={size ?? 24} color={color} />
            );
          },
        })}
      >
        <Tab.Screen name="Status" component={DashboardStackScreen} />
        <Tab.Screen name="Setup" component={SetupStackScreen} />
        <Tab.Screen
          name="Settings"
          component={SettingsScreen}
          options={{
            headerShown: true,
            headerStyle: { backgroundColor: COLORS.bg },
            headerTintColor: COLORS.textPrimary,
            header: () => null,
          }}
        />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
