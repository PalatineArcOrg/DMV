import React from 'react';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { DashboardScreen } from '../screens/DashboardScreen';
import { ExecutionLogScreen } from '../screens/ExecutionLogScreen';
import { SetupWizardScreen } from '../screens/SetupWizardScreen';
import { WelcomeScreen } from '../screens/WelcomeScreen';
import { HeartbeatConfigScreen } from '../screens/HeartbeatConfigScreen';
import { BeneficiaryScreen } from '../screens/BeneficiaryScreen';
import { DeFiPositionsScreen } from '../screens/DeFiPositionsScreen';
import { EstateReviewScreen } from '../screens/EstateReviewScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { COLORS, FONTS } from '../utils/constants';

const Tab = createBottomTabNavigator();
const DashboardStack = createNativeStackNavigator();
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
        name="ExecutionLog"
        component={ExecutionLogScreen}
        options={{ title: 'Execution Log' }}
      />
    </DashboardStack.Navigator>
  );
}

function SetupStackScreen() {
  return (
    <SetupStack.Navigator screenOptions={STACK_SCREEN_OPTIONS}>
      <SetupStack.Screen
        name="SetupWizard"
        component={SetupWizardScreen}
        options={{ title: 'Setup' }}
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

type TabIconName = 'view-dashboard' | 'text-box-outline' | 'cog';

const TAB_ICONS: Record<string, TabIconName> = {
  Status: 'view-dashboard',
  Setup: 'text-box-outline',
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
        <Tab.Screen name="Setup" component={SetupStackScreen} />
        <Tab.Screen name="Settings" component={SettingsScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
