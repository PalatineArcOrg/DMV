import React from 'react';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Text } from 'react-native';
import { DashboardScreen } from '../screens/DashboardScreen';
import { ExecutionLogScreen } from '../screens/ExecutionLogScreen';
import { SetupWizardScreen } from '../screens/SetupWizardScreen';
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
    </SetupStack.Navigator>
  );
}

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  const icons: Record<string, string> = {
    Status: '\u25CF',
    Setup: '\u2699',
    Settings: '\u2630',
  };
  return (
    <Text
      style={{
        fontSize: 18,
        color: focused ? COLORS.accent : COLORS.textMuted,
      }}
    >
      {icons[label] || '\u25CB'}
    </Text>
  );
}

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
          tabBarIcon: ({ focused }) => (
            <TabIcon label={route.name} focused={focused} />
          ),
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
