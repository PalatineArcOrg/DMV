import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StepIndicator } from '../components/StepIndicator';
import { COLORS, FONTS } from '../utils/constants';

const FEATURES = [
  {
    icon: 'flash' as const,
    color: '#9945FF',
    title: 'On-chain. No custodians.',
    description: 'Your vault runs as a Solana smart contract with full transparency.',
  },
  {
    icon: 'account-group' as const,
    color: '#00FFA3',
    title: 'Choose your beneficiaries',
    description: 'Set who receives your assets and in what proportions.',
  },
  {
    icon: 'lock' as const,
    color: '#4DA6FF',
    title: 'Regular heartbeat keeps it safe',
    description: 'Confirm you\'re in control with periodic check-ins.',
  },
];

export function WelcomeScreen() {
  const navigation = useNavigation<any>();

  // Ring animations
  const ring0Scale = useRef(new Animated.Value(1)).current;
  const ring0Opacity = useRef(new Animated.Value(0.5)).current;
  const ring1Scale = useRef(new Animated.Value(1)).current;
  const ring1Opacity = useRef(new Animated.Value(0.5)).current;
  const ring2Scale = useRef(new Animated.Value(1)).current;
  const ring2Opacity = useRef(new Animated.Value(0.5)).current;
  const glowScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const rings = [
      { scale: ring0Scale, opacity: ring0Opacity, duration: 3000, delay: 0 },
      { scale: ring1Scale, opacity: ring1Opacity, duration: 4000, delay: 800 },
      { scale: ring2Scale, opacity: ring2Opacity, duration: 5000, delay: 1600 },
    ];

    const anims = rings.map(({ scale, opacity, duration, delay }) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.parallel([
            Animated.sequence([
              Animated.timing(scale, { toValue: 1.05, duration: duration / 2, useNativeDriver: true }),
              Animated.timing(scale, { toValue: 1, duration: duration / 2, useNativeDriver: true }),
            ]),
            Animated.sequence([
              Animated.timing(opacity, { toValue: 1, duration: duration / 2, useNativeDriver: true }),
              Animated.timing(opacity, { toValue: 0.5, duration: duration / 2, useNativeDriver: true }),
            ]),
          ]),
        ]),
      ),
    );

    const glowAnim = Animated.loop(
      Animated.sequence([
        Animated.timing(glowScale, { toValue: 1.08, duration: 1500, useNativeDriver: true }),
        Animated.timing(glowScale, { toValue: 1, duration: 1500, useNativeDriver: true }),
      ]),
    );

    anims.forEach(a => a.start());
    glowAnim.start();

    return () => {
      anims.forEach(a => a.stop());
      glowAnim.stop();
    };
  }, []);

  return (
    <View style={styles.container}>
      <StepIndicator currentStep={1} totalSteps={4} labels={['Welcome', 'Beneficiaries', 'Heartbeat', 'Review']} />

      <View style={styles.content}>
        {/* Hero */}
        <View style={styles.hero}>
          <View style={styles.ringContainer}>
            <Animated.View style={[styles.ring, styles.ring2, { transform: [{ scale: ring2Scale }], opacity: ring2Opacity }]} />
            <Animated.View style={[styles.ring, styles.ring1, { transform: [{ scale: ring1Scale }], opacity: ring1Opacity }]} />
            <Animated.View style={[styles.ring, styles.ring0, { transform: [{ scale: ring0Scale }], opacity: ring0Opacity }]} />
            <Animated.View style={[styles.heroButton, { transform: [{ scale: glowScale }] }]}>
              <MaterialCommunityIcons name="shield" size={40} color={COLORS.accent} />
            </Animated.View>
          </View>
          <Text style={styles.title}>Dead Man's Vault</Text>
          <Text style={styles.subtitle}>
            Autonomous crypto inheritance for Solana. Set it up once, and your legacy is protected forever.
          </Text>
        </View>

        {/* Feature cards */}
        <View style={styles.features}>
          {FEATURES.map((feature, i) => (
            <View key={i} style={styles.featureCard}>
              <View style={[styles.featureIconBox, { backgroundColor: feature.color + '15', borderColor: feature.color + '25' }]}>
                <MaterialCommunityIcons name={feature.icon} size={18} color={feature.color} />
              </View>
              <View style={styles.featureText}>
                <Text style={styles.featureTitle}>{feature.title}</Text>
                <Text style={styles.featureDesc}>{feature.description}</Text>
              </View>
            </View>
          ))}
        </View>

        {/* CTA */}
        <View style={styles.ctaContainer}>
          <TouchableOpacity
            style={styles.ctaButton}
            onPress={() => navigation.navigate('Beneficiaries')}
            activeOpacity={0.8}
          >
            <Text style={styles.ctaText}>Get Started</Text>
            <MaterialCommunityIcons name="arrow-right" size={18} color={COLORS.bg} />
          </TouchableOpacity>
          <Text style={styles.ctaFooter}>Step 1 of 4 {'\u00B7'} Wallet connection required</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  content: {
    flex: 1,
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 32,
  },
  hero: {
    alignItems: 'center',
    marginTop: 8,
  },
  ringContainer: {
    width: 220,
    height: 220,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  ring: {
    position: 'absolute',
    borderWidth: 1,
    borderRadius: 999,
  },
  ring0: {
    width: 140,
    height: 140,
    borderColor: 'rgba(0,255,163,0.15)',
  },
  ring1: {
    width: 180,
    height: 180,
    borderColor: 'rgba(0,255,163,0.11)',
  },
  ring2: {
    width: 220,
    height: 220,
    borderColor: 'rgba(0,255,163,0.07)',
  },
  heroButton: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: 'rgba(0,255,163,0.15)',
    borderWidth: 1.5,
    borderColor: 'rgba(0,255,163,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: 'rgba(0,255,163,0.3)',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 24,
    elevation: 8,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: '#FFFFFF',
    fontFamily: FONTS.primaryBold,
    letterSpacing: -0.5,
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.55)',
    fontFamily: FONTS.primary,
    textAlign: 'center',
    lineHeight: 22,
    maxWidth: 300,
  },
  features: {
    gap: 12,
  },
  featureCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  featureIconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureText: {
    flex: 1,
  },
  featureTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#FFFFFF',
    fontFamily: FONTS.primarySemiBold,
    marginBottom: 2,
  },
  featureDesc: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.55)',
    fontFamily: FONTS.primary,
    lineHeight: 18,
  },
  ctaContainer: {
    alignItems: 'center',
  },
  ctaButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accent,
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 32,
    width: '100%',
    gap: 8,
  },
  ctaText: {
    color: COLORS.bg,
    fontSize: 15,
    fontWeight: '700',
    fontFamily: FONTS.primaryBold,
  },
  ctaFooter: {
    color: 'rgba(255,255,255,0.3)',
    fontSize: 11,
    fontFamily: FONTS.primary,
    marginTop: 12,
  },
});
