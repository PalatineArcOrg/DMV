import React, { useState, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Animated,
  Alert,
  ActivityIndicator,
  Linking,
} from 'react-native';
import * as ExpoClipboard from 'expo-clipboard';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Notifications from 'expo-notifications';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { PublicKey, Connection } from '@solana/web3.js';
import { useWallet } from '../hooks/useWallet';
import { useDemoStore } from '../store/useDemoStore';
import { useVaultStore } from '../store/useVaultStore';
import { useHeartbeatStore } from '../store/useHeartbeatStore';
import { useAuthStore } from '../store/useAuthStore';
import * as Crypto from 'expo-crypto';
import { COLORS, FONTS, PROGRAM_ID, STAGE_CONFIG, ESCALATION_DEFAULTS, NOTIFY_URL } from '../utils/constants';
import { truncateAddress, formatDuration } from '../utils/formatting';
import { RPC_OVERRIDE_KEY, explorerAddress, explorerTx, getRpcUrl, isCustomRpc, isDevnet, maskRpc, networkLabel } from '../utils/rpcConfig';
import { getSetting, setSetting, deleteSetting } from '../db/settingsRepo';
import { attemptSignedRegistration, attemptSignedDeregistration, successKey, deregPendingKey, closedVaultKey, recordVaultClosure, mapRegistrationError, mapDeregisterError } from '../services/NotificationRegistrationService';
import { makeTokenObserver, operationIdentity, runExclusive, LifecycleState } from '../services/notificationLifecycle';
import { DEV_ESCALATION } from '../hooks/useHeartbeat';
import { registerMessageV2, deregisterMessageV2, generateNonceV2 } from '../utils/notifyAuth';
import { PushRegistrationService } from '../services/PushRegistrationService';
import { useEscalationStore } from '../store/useEscalationStore';
import appJson from '../../app.json';

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

export function SettingsScreen() {
  const navigation = useNavigation<any>();
  const { publicKey, connected, connect, disconnect, signTransaction, signMessage } = useWallet();
  const { isDemoMode, setDemoMode, incrementTap } = useDemoStore();
  const { beneficiaries, vaultConfig } = useVaultStore();
  const heartbeatConfig = useHeartbeatStore((s) => s.config);
  const escalationStage = useEscalationStore((s) => s.state.stage);
  const { isAuthEnabled, setAuthEnabled } = useAuthStore();
  const [copied, setCopied] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);
  const [notifStatus, setNotifStatus] = useState<string>('...');

  // Custom RPC setting
  const [rpcInput, setRpcInput] = useState('');
  const [rpcSaved, setRpcSaved] = useState<string | null>(null);
  const [rpcTesting, setRpcTesting] = useState(false);
  const [rpcTestResult, setRpcTestResult] = useState<string | null>(null);
  // WP5/WP6: deliberate signed notification-registration + lifecycle state (this device).
  // 'registering'/'disabling' are the in-flight deliberate actions; the rest are derived
  // by local-only observation. Signing/mutation happens ONLY from a deliberate handler.
  type NotifRegState =
    | 'not_enabled' | 'checking' | 'registering' | 'enabled' | 'update_required'
    | 'disabling' | 'disabled' | 'token_unavailable' | 'owner_mismatch'
    | 'local_cleanup_pending' | 'vault_closed_cleanup_pending' | 'failed';
  const [notifReg, setNotifReg] = useState<{ state: NotifRegState; message: string | null }>({ state: 'not_enabled', message: null });
  // True only while a deliberate register/update/disable action is running, so the
  // background token observer never overwrites an in-flight action's UI.
  const notifBusyRef = useRef(false);
  const notifObserverRef = useRef<ReturnType<typeof makeTokenObserver> | null>(null);
  // In-session guard for the rare case where a signed deregistration succeeded server-side
  // but BOTH the local tombstone AND the durable-marker writes failed (total storage
  // failure): nothing durable exists, so the observer would reconcile the intact record back
  // to "enabled". While set, the observer's "enabled"/"update_required" emits are suppressed
  // so the UI never falsely shows "on" within the session. (A restart after a total write
  // failure is an accepted best-effort limitation — nothing can be persisted.)
  const notifDeregPendingSessionRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      getSetting(RPC_OVERRIDE_KEY)
        .then((v) => {
          setRpcSaved(v);
          setRpcInput(v ?? '');
        })
        .catch(() => {});
    }, []),
  );

  const handleTestRpc = useCallback(async () => {
    const url = rpcInput.trim();
    if (!url) return;
    setRpcTesting(true);
    setRpcTestResult(null);
    try {
      const conn = new Connection(url);
      await raceTimeout(conn.getVersion(), 5000);
      let das = false;
      try {
        const resp = (await raceTimeout(
          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: '1',
              method: 'getAssetsByOwner',
              params: { ownerAddress: PublicKey.default.toBase58(), page: 1, limit: 1 },
            }),
          }),
          5000,
        )) as Response;
        const j = await resp.json();
        das = !j.error;
      } catch {
        das = false;
      }
      setRpcTestResult(
        `Reachable · ${das ? 'DAS supported (full NFT data)' : 'DAS not supported (NFT data limited)'}`,
      );
    } catch {
      setRpcTestResult('Unreachable — check the URL');
    } finally {
      setRpcTesting(false);
    }
  }, [rpcInput]);

  const handleSaveRpc = useCallback(async () => {
    const url = rpcInput.trim();
    if (!url) return;
    if (!/^https:\/\/[^\s]+$/i.test(url)) {
      Alert.alert('Invalid URL', 'Enter a valid https:// RPC URL.');
      return;
    }
    await setSetting(RPC_OVERRIDE_KEY, url);
    setRpcSaved(url);
    Alert.alert('Saved', 'Custom RPC saved. Restart the app to apply.');
  }, [rpcInput]);

  const handleResetRpc = useCallback(async () => {
    await deleteSetting(RPC_OVERRIDE_KEY);
    setRpcSaved(null);
    setRpcInput('');
    setRpcTestResult(null);
    Alert.alert('Reset', 'Reverted to the default RPC. Restart the app to apply.');
  }, []);

  // Shared derivations for the notification lifecycle handlers/observer.
  const notifSha256Hex = useCallback((t: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, t), []);
  const deriveVaultB58 = useCallback(
    (owner: string) => PublicKey.findProgramAddressSync([Buffer.from('vault'), new PublicKey(owner).toBuffer()], new PublicKey(PROGRAM_ID))[0].toBase58(),
    [],
  );
  const notifCluster = isDevnet() ? 'devnet' : 'mainnet-beta';
  const mapLifecycleToUi = useCallback((s: LifecycleState): NotifRegState => (s === 'error' ? 'failed' : (s as NotifRegState)), []);

  // WP6 — token lifecycle: LOCAL-ONLY observation. Derives the notification state
  // (enabled / update_required / token_unavailable / owner_mismatch / disabled) by
  // comparing the current device-token fingerprint to the confirmed record, and on a
  // token change it detects/persists a local pending marker. It NEVER signs and NEVER
  // issues a /register or /deregister request — all server mutation is a deliberate
  // handler below (Enable / Update / Disable). It never overwrites an in-flight action.
  React.useEffect(() => {
    if (!publicKey) {
      setNotifReg((prev) => (prev.state === 'registering' || prev.state === 'disabling' ? prev : { state: 'not_enabled', message: null }));
      return;
    }
    const observer = makeTokenObserver({
      cluster: notifCluster,
      programId: PROGRAM_ID,
      getConnectedOwner: () => publicKey?.toBase58() ?? null,
      deriveVault: deriveVaultB58,
      getCurrentToken: () => PushRegistrationService.getDeviceToken(),
      sha256Hex: notifSha256Hex,
      getSetting,
      setSetting,
      successKeyFor: successKey,
      deregPendingKeyFor: deregPendingKey,
      closedVaultKeyFor: closedVaultKey,
      subscribe: (cb) => {
        const sub = Notifications.addPushTokenListener(() => cb());
        return () => sub.remove();
      },
      nowMs: () => Date.now(),
      onState: (s) => {
        if (notifBusyRef.current) return; // never stomp an in-flight deliberate action
        // Total-write-failure guard: while a deregistration is session-pending with no durable
        // state, never let the intact record resurface "enabled"/"update_required".
        if (notifDeregPendingSessionRef.current && (s === 'enabled' || s === 'update_required')) return;
        // A clean disabled/not_enabled (e.g. a durable-marker repair landed) clears the guard.
        if (s === 'disabled' || s === 'not_enabled') notifDeregPendingSessionRef.current = false;
        setNotifReg({ state: mapLifecycleToUi(s), message: null });
      },
    });
    observer.start();
    notifObserverRef.current = observer;
    void observer.checkNow();
    return () => {
      observer.dispose();
      notifObserverRef.current = null;
    };
  }, [publicKey, notifCluster, deriveVaultB58, notifSha256Hex, mapLifecycleToUi]);

  // Re-reconcile on Settings focus (LOCAL only — never signs or mutates the server). The
  // observer's checkNow durably repairs a pending local tombstone (LOCAL write only) before
  // reconciling, so a prior deregistration is never resurfaced as "enabled".
  useFocusEffect(useCallback(() => {
    if (!notifBusyRef.current) void notifObserverRef.current?.checkNow();
  }, []));

  // WP5/WP6: DELIBERATE owner-signed registration / token rotation. Runs ONLY from an
  // explicit tap. Enable and Update share this coordinator (rotation = a higher-revision
  // register). Guarded by the identity-scoped lifecycle lock so it cannot race a disable.
  const handleEnableSignedNotifications = useCallback(async () => {
    if (notifReg.state === 'registering' || notifBusyRef.current) return; // single-flight
    if (!publicKey) {
      setNotifReg({ state: 'failed', message: 'Connect your wallet first.' });
      return;
    }
    const owner = publicKey.toBase58();
    const vault = deriveVaultB58(owner);
    const identity = operationIdentity({ cluster: notifCluster, programId: PROGRAM_ID, owner, vault });
    const op = notifReg.state === 'update_required' ? 'update' : 'register';
    // Register the SAME stage durations the app's escalation actually uses (demo/dev = 30s
    // each; otherwise the production defaults) so server-side timing matches the device.
    const useDevTimers = __DEV__ || isDemoMode;
    const stages = useDevTimers
      ? { stage1: DEV_ESCALATION.stage1Duration, stage2: DEV_ESCALATION.stage2Duration, stage3: DEV_ESCALATION.stage3Duration }
      : { stage1: ESCALATION_DEFAULTS.stage1, stage2: ESCALATION_DEFAULTS.stage2, stage3: ESCALATION_DEFAULTS.stage3 };
    notifBusyRef.current = true;
    notifDeregPendingSessionRef.current = false; // a deliberate (re-)enable supersedes any pending-dereg guard
    setNotifReg({ state: 'registering', message: null });
    try {
      const ex = await runExclusive(identity, op, () => attemptSignedRegistration(
        { owner, stages },
        {
          cluster: notifCluster,
          programId: PROGRAM_ID,
          deriveVault: deriveVaultB58,
          getDeviceToken: () => PushRegistrationService.getDeviceToken(),
          getSetting,
          setSetting,
          signMessage,
          buildRegisterMessage: registerMessageV2,
          generateNonce: generateNonceV2,
          sha256Hex: notifSha256Hex,
          postRegister: async (body) => {
            const res = await fetch(`${NOTIFY_URL}/register`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            });
            let code: string | undefined;
            try {
              code = (await res.json())?.code;
            } catch {
              /* no/invalid JSON body — status alone drives the outcome */
            }
            return { status: res.status, code, retryAfter: res.headers.get('retry-after') };
          },
          nowSec: () => Math.floor(Date.now() / 1000),
          nowMs: () => Date.now(),
        },
      ));
      if (!ex.ran) {
        if (ex.reason === 'conflict') setNotifReg({ state: 'failed', message: 'Another notification action is in progress. Try again in a moment.' });
        return; // noop: a concurrent identical action is already running
      }
      const result = ex.value;
      if (result.ok) {
        // Re-derive authoritatively from storage + the latest token. This bumps the observer
        // generation (so no stale in-flight check can stomp this result) and naturally
        // implements the §6 token-change race: enabled only if the accepted token is still the
        // latest, else update_required. If the local success write failed it shows not_enabled.
        notifBusyRef.current = false;
        await notifObserverRef.current?.checkNow();
      } else if (result.stage === 'wallet') {
        // Wallet cancellation → reconcile back to the prior local state (no claim of success).
        notifBusyRef.current = false;
        await notifObserverRef.current?.checkNow();
      } else if (result.stage === 'in_flight') {
        /* concurrent duplicate — leave the in-flight UI untouched */
      } else {
        const mapped = mapRegistrationError(result.code || result.stage);
        setNotifReg({ state: 'failed', message: mapped.message });
      }
    } catch {
      // A coordinator throw must never wedge the UI at "Registering…".
      setNotifReg({ state: 'failed', message: 'Registration failed. Please try again.' });
    } finally {
      notifBusyRef.current = false;
      notifObserverRef.current?.invalidate(); // kill any stale in-flight check so it can't stomp the terminal state
    }
  }, [notifReg.state, publicKey, signMessage, notifCluster, deriveVaultB58, notifSha256Hex]);

  // WP6: DELIBERATE owner-signed DEREGISTRATION core. Only ever called from a confirmed
  // user action below. Never called on mount/heartbeat/disconnect/account-change/token-loss.
  const runDisable = useCallback(async (context?: 'post_close_cleanup') => {
    if (!publicKey || notifBusyRef.current) return;
    const owner = publicKey.toBase58();
    const vault = deriveVaultB58(owner);
    const identity = operationIdentity({ cluster: notifCluster, programId: PROGRAM_ID, owner, vault });
    notifBusyRef.current = true;
    setNotifReg({ state: 'disabling', message: null });
    try {
      const ex = await runExclusive(identity, 'deregister', () => attemptSignedDeregistration(
        { owner, context },
        {
          cluster: notifCluster,
          programId: PROGRAM_ID,
          deriveVault: deriveVaultB58,
          getSetting,
          setSetting,
          signMessage,
          buildDeregisterMessage: deregisterMessageV2,
          generateNonce: generateNonceV2,
          postDeregister: async (body) => {
            const res = await fetch(`${NOTIFY_URL}/deregister`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            });
            let code: string | undefined;
            let removed: number | undefined;
            try {
              const j = await res.json();
              code = j?.code;
              removed = typeof j?.removed === 'number' ? j.removed : undefined;
            } catch {
              /* status drives the outcome */
            }
            return { status: res.status, code, removed, retryAfter: res.headers.get('retry-after') };
          },
          nowSec: () => Math.floor(Date.now() / 1000),
        },
      ));
      if (!ex.ran) {
        if (ex.reason === 'conflict') setNotifReg({ state: 'failed', message: 'Another notification action is in progress. Try again in a moment.' });
        return;
      }
      const result = ex.value;
      if (result.ok && result.localCleanupPending) {
        // Server deregistered but the local tombstone write failed. Show disabled/cleanup via
        // PURE React state (no storage write needed, so this holds even under a total write
        // failure) and set the session guard so a later observer reconcile of the still-intact
        // record can't resurface "enabled". If the coordinator's durable marker DID persist,
        // the observer repairs it to "disabled" on the next reconcile (which clears the guard).
        notifDeregPendingSessionRef.current = true;
        setNotifReg({ state: 'local_cleanup_pending', message: 'Notifications disabled on the server. Finishing local cleanup…' });
      } else if (result.ok) {
        // Tombstone written (or a no-op with no record). Re-derive authoritatively: checkNow →
        // disabled (or not_enabled). Bumps the observer generation so no stale check can stomp it.
        notifBusyRef.current = false;
        await notifObserverRef.current?.checkNow();
      } else if (result.stage === 'wallet') {
        // Cancellation → reconcile back to the prior local state.
        notifBusyRef.current = false;
        await notifObserverRef.current?.checkNow();
      } else if (result.stage === 'in_flight') {
        /* concurrent duplicate — leave the in-flight UI untouched */
      } else if (result.stage === 'owner_mismatch') {
        setNotifReg({ state: 'owner_mismatch', message: 'This vault is registered to a different wallet.' });
      } else {
        const mapped = mapDeregisterError(result.code || result.stage);
        setNotifReg({ state: 'failed', message: mapped.message });
      }
    } catch {
      setNotifReg({ state: 'failed', message: 'Could not disable notifications. Please try again.' });
    } finally {
      notifBusyRef.current = false;
      notifObserverRef.current?.invalidate(); // kill any stale in-flight check so it can't stomp the terminal state
    }
  }, [publicKey, notifCluster, deriveVaultB58, signMessage]);

  // Deliberate disable with a plain-language confirmation (works after vault closure).
  const handleDisableSignedNotifications = useCallback(() => {
    if (!publicKey) {
      setNotifReg({ state: 'failed', message: 'Connect your wallet first.' });
      return;
    }
    Alert.alert(
      'Disable notifications',
      'This stops escalation notifications for this vault. The wallet signature does not move funds. It still works after the vault is closed. Re-enabling later requires another signature.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Disable', style: 'destructive', onPress: () => { void runDisable(); } },
      ],
    );
  }, [publicKey, runDisable]);

  // Advanced: clear a server registration when there is no local record. May be a no-op
  // (idempotent removed=0); it does not claim a registration existed.
  const handleClearServerRegistration = useCallback(() => {
    if (!publicKey) {
      setNotifReg({ state: 'failed', message: 'Connect your wallet first.' });
      return;
    }
    Alert.alert(
      'Clear server notification registration',
      'This asks the server to remove any notification registration for this vault. It may safely do nothing. The wallet signature does not move funds.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear', style: 'destructive', onPress: () => { void runDisable(); } },
      ],
    );
  }, [publicKey, runDisable]);

  // WP6.1: explicit post-close cleanup for the `vault_closed_cleanup_pending` state (after a
  // confirmed revoke). One signature reconciles the notification server row; because closure
  // is locally proven (durable closed-vault tombstone), a server `ownership_failed` (the
  // poller may have already removed the row) is treated as an idempotent already-disabled.
  const handlePostCloseCleanup = useCallback(() => {
    if (!publicKey) {
      setNotifReg({ state: 'failed', message: 'Connect your wallet first.' });
      return;
    }
    Alert.alert(
      'Clear server notification registration',
      'Your vault is already closed. This only reconciles notification state — the wallet signature moves no funds. The server may already have removed the registration, so this can be a harmless no-op.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear', style: 'destructive', onPress: () => { void runDisable('post_close_cleanup'); } },
      ],
    );
  }, [publicKey, runDisable]);

  // WP6.1: after a CONFIRMED owner-authorized revoke that closed the vault, record a durable
  // closed-vault tombstone (LOCAL-ONLY — no sign, no server call) so the notification UI never
  // shows a stale "enabled" for the closed vault, then re-derive via the observer. Best-effort:
  // never blocks or alters the revoke result.
  const reconcileNotificationsAfterClose = useCallback(async (result: { status: string; executed?: boolean; txs: { sig: string }[] }) => {
    try {
      if (!publicKey) return;
      const closedOnChain = result.status === 'revoked' || (result.status === 'cleared' && !!result.executed);
      const revokeSig = result.txs && result.txs.length ? result.txs[result.txs.length - 1].sig : '';
      if (!closedOnChain || !revokeSig) return;
      await recordVaultClosure(
        { owner: publicKey.toBase58(), revokeSig, revokedAt: Math.floor(Date.now() / 1000) },
        { cluster: notifCluster, programId: PROGRAM_ID, deriveVault: deriveVaultB58, getSetting, setSetting },
      );
      notifObserverRef.current?.invalidate();
      await notifObserverRef.current?.checkNow();
    } catch {
      /* best-effort notification reconciliation; never blocks the revoke */
    }
  }, [publicKey, notifCluster, deriveVaultB58]);

  useFocusEffect(useCallback(() => {
    Notifications.getPermissionsAsync().then(({ status }) => {
      setNotifStatus(status === 'granted' ? 'Enabled' : 'Disabled');
    });
  }, []));

  const isOwner = vaultConfig?.owner && publicKey
    ? vaultConfig.owner.toBase58() === publicKey.toBase58()
    : false;

  const programPubkey = useMemo(() => new PublicKey(PROGRAM_ID), []);
  const vaultPda = useMemo(() => {
    if (!publicKey) return null;
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), publicKey.toBuffer()],
      programPubkey,
    );
    return pda;
  }, [publicKey, programPubkey]);

  const stageCfg = STAGE_CONFIG[escalationStage] ?? STAGE_CONFIG[0];

  const handleCopy = useCallback(() => {
    if (publicKey) {
      ExpoClipboard.setStringAsync(publicKey.toBase58());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [publicKey]);

  const handleRevoke = useCallback(async () => {
    if (!publicKey) return;

    Alert.alert(
      'Revoke Vault?',
      'This will withdraw all deposited assets, deactivate your vault on-chain, and clear all local data. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: async () => {
            setIsRevoking(true);
            try {
              const { revokeVault, formatRevokeSummary } = require('../services/revokeVault');
              const result = await revokeVault(publicKey, signTransaction);
              const summary = formatRevokeSummary(result);
              await reconcileNotificationsAfterClose(result); // WP6.1: no stale "enabled" after revoke

              const buttons = [
                ...summary.txs.slice(0, 2).map((t: { label: string; sig: string }, i: number) => ({
                  text: `View tx ${i + 1}`,
                  onPress: () => Linking.openURL(explorerTx(t.sig)),
                })),
                { text: 'Done' },
              ];
              Alert.alert(summary.title, summary.message, buttons);
            } catch (err: any) {
              const { NotOwnerError } = require('../services/revokeVault');
              if (err instanceof NotOwnerError) {
                Alert.alert('Not Owner', 'This vault belongs to a different wallet.');
                return;
              }
              const msg = err.message || String(err);
              if (msg.includes('CancellationException') || msg.includes('cancelled')) {
                Alert.alert('Cancelled', 'Wallet signing was cancelled.');
              } else {
                Alert.alert('Error', msg);
              }
            } finally {
              setIsRevoking(false);
            }
          },
        },
      ],
    );
  }, [publicKey, signTransaction, reconcileNotificationsAfterClose]);

  const handleCloseExecuted = useCallback(async () => {
    if (!publicKey) return;

    Alert.alert(
      'Close Executed Vault?',
      'Your estate plan already executed. This closes the vault on-chain and returns its remaining rent to your wallet. It removes the vault from this device.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Close Vault',
          style: 'destructive',
          onPress: async () => {
            setIsRevoking(true);
            try {
              const { revokeVault, formatRevokeSummary } = require('../services/revokeVault');
              const result = await revokeVault(publicKey, signTransaction);
              const summary = formatRevokeSummary(result);
              const buttons = [
                ...summary.txs.slice(0, 2).map((t: { label: string; sig: string }, i: number) => ({
                  text: `View tx ${i + 1}`,
                  onPress: () => Linking.openURL(explorerTx(t.sig)),
                })),
                { text: 'Done' },
              ];
              Alert.alert(summary.title, summary.message, buttons);
            } catch (err: any) {
              const msg = err.message || String(err);
              if (msg.includes('CancellationException') || msg.includes('cancelled')) {
                Alert.alert('Cancelled', 'Wallet signing was cancelled.');
              } else {
                Alert.alert('Error', msg);
              }
            } finally {
              setIsRevoking(false);
            }
          },
        },
      ],
    );
  }, [publicKey, signTransaction]);

  const handleEditBeneficiaries = useCallback(() => {
    navigation.navigate('Vault', {
      screen: 'Beneficiaries',
      params: { fromSettings: true },
    });
  }, [navigation]);

  const handleAuthToggle = useCallback(async (enabled: boolean) => {
    if (enabled) {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();
      if (!hasHardware || !isEnrolled) {
        Alert.alert('Not Available', 'Biometric authentication is not set up on this device.');
        return;
      }
    }
    setAuthEnabled(enabled);
  }, [setAuthEnabled]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <Text style={styles.header}>Settings</Text>

      {/* Vault Status */}
      {vaultConfig && isOwner && (
        <View style={styles.sectionBlock}>
          <Text style={styles.sectionLabel}>VAULT STATUS</Text>
          <View style={styles.card}>
            <View style={[styles.statusRow, { borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' }]}>
              {vaultConfig.executed ? (
                <>
                  <View style={[styles.statusDot, { backgroundColor: COLORS.critical }]} />
                  <Text style={[styles.statusLabelText, { color: COLORS.critical }]}>Executed</Text>
                  <Text style={styles.statusStageBadge}>{'\u00B7'} distribution complete</Text>
                </>
              ) : (
                <>
                  <View style={[styles.statusDot, { backgroundColor: stageCfg.color }]} />
                  <Text style={[styles.statusLabelText, { color: stageCfg.color }]}>{stageCfg.label}</Text>
                  <Text style={styles.statusStageBadge}>{'\u00B7'} Stage {escalationStage}</Text>
                </>
              )}
            </View>
            <View style={styles.statusGrid}>
              <View style={styles.statusGridCell}>
                <Text style={styles.statusGridLabel}>Interval</Text>
                <Text style={styles.statusGridValue}>
                  {heartbeatConfig ? formatDuration(heartbeatConfig.intervalSeconds) : '-'}
                </Text>
              </View>
              <View style={[styles.statusGridCell, styles.statusGridCellBorder]}>
                <Text style={styles.statusGridLabel}>Grace</Text>
                <Text style={styles.statusGridValue}>
                  {heartbeatConfig ? `${Math.round((ESCALATION_DEFAULTS.stage1 + ESCALATION_DEFAULTS.stage2 + ESCALATION_DEFAULTS.stage3) / 86400)}d` : '-'}
                </Text>
              </View>
              <View style={styles.statusGridCell}>
                <Text style={styles.statusGridLabel}>Recipients</Text>
                <Text style={styles.statusGridValue}>{beneficiaries.length}</Text>
              </View>
            </View>
          </View>
        </View>
      )}

      {/* Inheritances */}
      <View style={styles.sectionBlock}>
        <Text style={styles.sectionLabel}>INHERITANCES</Text>
        <View style={styles.card}>
          <TouchableOpacity onPress={() => navigation.navigate('Status', { screen: 'Inheritances' })}>
            <SettingRow
              icon="gift-outline"
              iconColor={COLORS.accent}
              label="Claim an Inheritance"
              value=""
              link
            />
          </TouchableOpacity>
        </View>
      </View>

      {/* Security */}
      <View style={styles.sectionBlock}>
        <Text style={styles.sectionLabel}>SECURITY</Text>
        <View style={styles.card}>
          <ToggleRow
            icon="fingerprint"
            iconColor={COLORS.accent}
            label="App Lock"
            description="Require biometric or PIN to open"
            value={isAuthEnabled}
            onChange={handleAuthToggle}
          />
          <View style={styles.rowDivider} />
          <TouchableOpacity onPress={() => { if (notifStatus === 'Disabled') Linking.openSettings(); }}>
            <SettingRow
              icon="bell-outline"
              iconColor={notifStatus === 'Enabled' ? COLORS.accent : COLORS.warning}
              label="Notifications"
              value={notifStatus}
            />
          </TouchableOpacity>
          <View style={styles.rowDivider} />
          <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 14 }}>
            <Text style={{ color: COLORS.textSecondary, fontFamily: FONTS.primaryMedium, fontSize: 13, lineHeight: 18, marginBottom: 10 }}>
              A wallet signature authorizes escalation notifications to this device. It does not move funds.
              {vaultPda ? `  Vault ${truncateAddress(vaultPda.toBase58(), 4)}.` : ''}
            </Text>
            {/* Lifecycle status lines (local-only detection). */}
            {notifReg.state === 'update_required' ? (
              <Text style={{ color: COLORS.warning, fontFamily: FONTS.primaryMedium, fontSize: 12, marginBottom: 8 }}>
                Notification token changed — update required. The server may still point at the previous device token until you sign the update.
              </Text>
            ) : null}
            {notifReg.state === 'token_unavailable' ? (
              <Text style={{ color: COLORS.warning, fontFamily: FONTS.primaryMedium, fontSize: 12, marginBottom: 8 }}>
                The device push token is unavailable right now. Your existing registration is unchanged.
              </Text>
            ) : null}
            {notifReg.state === 'owner_mismatch' ? (
              <Text style={{ color: COLORS.warning, fontFamily: FONTS.primaryMedium, fontSize: 12, marginBottom: 8 }}>
                This device's notification record belongs to a different wallet. Connect the matching wallet to manage it.
              </Text>
            ) : null}
            {notifReg.state === 'enabled' ? (
              <Text style={{ color: COLORS.accent, fontFamily: FONTS.primaryMedium, fontSize: 12, marginBottom: 8 }}>
                Notifications enabled on this device.
              </Text>
            ) : null}
            {notifReg.state === 'disabled' ? (
              <Text style={{ color: COLORS.textSecondary, fontFamily: FONTS.primaryMedium, fontSize: 12, marginBottom: 8 }}>
                Notifications disabled on this device.
              </Text>
            ) : null}
            {notifReg.state === 'local_cleanup_pending' ? (
              <Text style={{ color: COLORS.textSecondary, fontFamily: FONTS.primaryMedium, fontSize: 12, marginBottom: 8 }}>
                {notifReg.message || 'Notifications disabled on the server. Finishing local cleanup…'}
              </Text>
            ) : null}
            {notifReg.state === 'vault_closed_cleanup_pending' ? (
              <Text style={{ color: COLORS.warning, fontFamily: FONTS.primaryMedium, fontSize: 12, marginBottom: 8 }}>
                Vault closed — notification cleanup pending. The server registration may still point at the closed vault until you clear it.
              </Text>
            ) : null}

            {/* Enable / Update primary action (hidden once enabled). Shown for a closed vault too,
                so a NEW vault re-initialized at the same owner PDA can re-enable; for a truly-closed
                vault the register just fails ownership gracefully. */}
            {notifReg.state !== 'enabled' ? (
              <TouchableOpacity
                disabled={notifReg.state === 'registering' || notifReg.state === 'disabling' || notifReg.state === 'checking' || !connected}
                onPress={handleEnableSignedNotifications}
                style={[styles.netBtn, (notifReg.state === 'registering' || notifReg.state === 'disabling' || notifReg.state === 'checking' || !connected) && { opacity: 0.5 }]}
              >
                <Text style={styles.netBtnText}>
                  {notifReg.state === 'registering'
                    ? 'Signing…'
                    : notifReg.state === 'disabling'
                      ? 'Disabling…'
                      : notifReg.state === 'checking'
                        ? 'Checking…'
                        : notifReg.state === 'update_required'
                          ? 'Update notification registration'
                          : 'Enable notifications (signed)'}
                </Text>
              </TouchableOpacity>
            ) : null}

            {/* Disable (when a registration exists on this device). */}
            {notifReg.state === 'enabled' || notifReg.state === 'update_required' ? (
              <TouchableOpacity
                disabled={!connected}
                onPress={handleDisableSignedNotifications}
                style={{ marginTop: 8, paddingVertical: 10, alignItems: 'center' }}
              >
                <Text style={{ color: COLORS.critical, fontFamily: FONTS.primaryMedium, fontSize: 13 }}>Disable notifications</Text>
              </TouchableOpacity>
            ) : null}

            {/* Retry the local token check. */}
            {notifReg.state === 'token_unavailable' ? (
              <TouchableOpacity
                onPress={() => { void notifObserverRef.current?.checkNow(); }}
                style={{ marginTop: 8, paddingVertical: 10, alignItems: 'center' }}
              >
                <Text style={{ color: COLORS.textSecondary, fontFamily: FONTS.primaryMedium, fontSize: 13 }}>Retry token check</Text>
              </TouchableOpacity>
            ) : null}

            {/* WP6.1: post-close cleanup for a revoked vault (the only deliberate action here). */}
            {notifReg.state === 'vault_closed_cleanup_pending' ? (
              <TouchableOpacity
                disabled={!connected}
                onPress={handlePostCloseCleanup}
                style={[styles.netBtn, !connected && { opacity: 0.5 }]}
              >
                <Text style={styles.netBtnText}>Clear server notification registration</Text>
              </TouchableOpacity>
            ) : null}

            {/* Advanced: clear a server registration when no local record exists. */}
            {notifReg.state === 'not_enabled' || notifReg.state === 'disabled' || notifReg.state === 'failed' ? (
              <TouchableOpacity
                disabled={!connected}
                onPress={handleClearServerRegistration}
                style={{ marginTop: 8, paddingVertical: 8, alignItems: 'center' }}
              >
                <Text style={{ color: COLORS.textSecondary, fontFamily: FONTS.primaryMedium, fontSize: 12 }}>Clear server notification registration</Text>
              </TouchableOpacity>
            ) : null}

            {notifReg.state === 'failed' && notifReg.message ? (
              <Text style={{ color: COLORS.critical, fontFamily: FONTS.primaryMedium, fontSize: 12, marginTop: 8 }}>
                {notifReg.message}
              </Text>
            ) : null}
          </View>
        </View>
      </View>

      {/* Network */}
      <View style={styles.sectionBlock}>
        <Text style={styles.sectionLabel}>NETWORK</Text>
        <View style={styles.card}>
          <View style={styles.netRow}>
            <Text style={styles.netLabel}>Current RPC</Text>
            <View style={styles.netBadge}>
              <Text style={styles.netBadgeText}>{isCustomRpc() ? 'Custom' : 'Default'}</Text>
            </View>
          </View>
          <Text style={styles.netEndpoint} numberOfLines={1}>
            {isCustomRpc() ? maskRpc(getRpcUrl()) : 'Default DMV RPC API'}
          </Text>
          <TextInput
            style={styles.netInput}
            value={rpcInput}
            onChangeText={setRpcInput}
            placeholder="https://your-rpc-url"
            placeholderTextColor="rgba(255,255,255,0.25)"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          {rpcTestResult ? <Text style={styles.netTestResult}>{rpcTestResult}</Text> : null}
          <View style={styles.netBtnRow}>
            <TouchableOpacity
              style={styles.netBtn}
              onPress={handleTestRpc}
              disabled={rpcTesting || !rpcInput.trim()}
            >
              {rpcTesting ? (
                <ActivityIndicator size="small" color={COLORS.accent} />
              ) : (
                <Text style={styles.netBtnText}>Test</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.netBtn, styles.netBtnPrimary]}
              onPress={handleSaveRpc}
              disabled={!rpcInput.trim()}
            >
              <Text style={[styles.netBtnText, styles.netBtnTextPrimary]}>Save</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.netBtn} onPress={handleResetRpc} disabled={!rpcSaved}>
              <Text style={styles.netBtnText}>Reset</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.netHelp}>
            For NFT &amp; full portfolio data, use a Helius-compatible (DAS) RPC URL. Restart the app to apply.
          </Text>
        </View>
      </View>

      {/* Developer */}
      <View style={styles.sectionBlock}>
        <Text style={styles.sectionLabel}>DEVELOPER</Text>
        <View style={styles.card}>
          <ToggleRow
            icon="flash"
            iconColor="#F59E0B"
            label="Demo Mode"
            description="Show stage controls on dashboard"
            value={isDemoMode}
            onChange={setDemoMode}
          />
        </View>
      </View>

      {/* Wallet */}
      <View style={styles.sectionBlock}>
        <Text style={styles.sectionLabel}>WALLET</Text>
        <View style={styles.card}>
          {connected && publicKey ? (
            <>
              <View style={styles.walletRow}>
                <View style={styles.walletIcon}>
                  <MaterialCommunityIcons name="wallet" size={15} color={COLORS.solanaPurple} />
                </View>
                <View style={styles.walletInfo}>
                  <Text style={styles.walletLabel}>Connected Wallet</Text>
                  <Text style={styles.walletAddr}>{truncateAddress(publicKey.toBase58(), 6)}</Text>
                </View>
                <TouchableOpacity
                  style={[styles.copyBtn, copied && styles.copyBtnActive]}
                  onPress={handleCopy}
                >
                  <MaterialCommunityIcons
                    name={copied ? 'check' : 'content-copy'}
                    size={13}
                    color={copied ? COLORS.accent : 'rgba(255,255,255,0.4)'}
                  />
                </TouchableOpacity>
              </View>
              <View style={styles.rowDivider} />
              <TouchableOpacity style={styles.actionRow} onPress={disconnect}>
                <View style={[styles.actionIcon, { backgroundColor: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.25)' }]}>
                  <MaterialCommunityIcons name="logout" size={15} color={COLORS.critical} />
                </View>
                <Text style={[styles.actionLabel, { color: COLORS.critical }]}>Disconnect Wallet</Text>
                <MaterialCommunityIcons name="chevron-right" size={14} color="rgba(255,255,255,0.2)" />
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity style={styles.connectBtn} onPress={connect}>
              <MaterialCommunityIcons name="wallet" size={16} color={COLORS.bg} />
              <Text style={styles.connectBtnText}>Connect Wallet</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Vault Contract */}
      <View style={styles.sectionBlock}>
        <Text style={styles.sectionLabel}>VAULT CONTRACT</Text>
        <View style={styles.card}>
          <TouchableOpacity onPress={() => Linking.openURL(explorerAddress(PROGRAM_ID))}>
            <SettingRow icon="check-decagram" iconColor={COLORS.accent} label="Vault Program" value={truncateAddress(PROGRAM_ID, 4)} link />
          </TouchableOpacity>
          {vaultConfig && vaultPda && (
            <>
              <View style={styles.rowDivider} />
              <TouchableOpacity onPress={() => Linking.openURL(explorerAddress(vaultPda.toBase58()))}>
                <SettingRow icon="safe-square-outline" iconColor={COLORS.blueAccent} label="Your Vault" value={truncateAddress(vaultPda.toBase58(), 4)} link />
              </TouchableOpacity>
            </>
          )}
          <View style={styles.rowDivider} />
          <SettingRow icon="account-group" iconColor={COLORS.solanaPurple} label="Beneficiaries" value={`${beneficiaries.length} configured`} />
          <View style={styles.rowDivider} />
          <SettingRow icon="clock-outline" iconColor={COLORS.blueAccent} label="Heartbeat Interval" value={heartbeatConfig ? formatDuration(heartbeatConfig.intervalSeconds) : vaultConfig ? formatDuration(vaultConfig.heartbeatInterval.toNumber()) : 'Not set'} />
          <View style={styles.rowDivider} />
          <SettingRow icon="lock-outline" iconColor={vaultConfig?.isMutable === false ? COLORS.critical : COLORS.accent} label="Vault Type" value={vaultConfig?.isMutable === false ? 'Immutable' : 'Mutable'} />
          {vaultConfig && (
            <>
              <View style={styles.rowDivider} />
              <SettingRow icon="circle-slice-8" iconColor={vaultConfig.executed ? COLORS.critical : COLORS.accent} label="Status" value={vaultConfig.executed ? 'Executed' : 'Active'} />
            </>
          )}
          <View style={styles.rowDivider} />
          <SettingRow icon="web" iconColor="rgba(255,255,255,0.3)" label="Network" value={networkLabel()} />
          {isOwner && vaultConfig && vaultConfig.active && !vaultConfig.executed && vaultConfig.isMutable !== false && (
            <>
              <View style={styles.rowDivider} />
              <TouchableOpacity style={styles.actionRow} onPress={handleEditBeneficiaries}>
                <View style={[styles.actionIcon, { backgroundColor: 'rgba(153,69,255,0.12)', borderColor: 'rgba(153,69,255,0.25)' }]}>
                  <MaterialCommunityIcons name="account-edit" size={15} color={COLORS.solanaPurple} />
                </View>
                <Text style={[styles.actionLabel, { color: COLORS.solanaPurple }]}>Edit Beneficiaries</Text>
                <MaterialCommunityIcons name="chevron-right" size={14} color="rgba(255,255,255,0.2)" />
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>

      {/* About */}
      <View style={styles.sectionBlock}>
        <Text style={styles.sectionLabel}>ABOUT</Text>
        <View style={styles.card}>
          <TouchableOpacity onPress={incrementTap} activeOpacity={0.7}>
            <SettingRow icon="information-outline" iconColor="rgba(255,255,255,0.3)" label="Version" value={`v${appJson.expo.version}`} />
          </TouchableOpacity>
          <View style={styles.rowDivider} />
          <SettingRow icon="cellphone" iconColor="rgba(255,255,255,0.3)" label="Built for" value="Solana Seeker" />
        </View>
      </View>

      {/* Danger Zone */}
      {isOwner && vaultConfig && (vaultConfig.active || vaultConfig.executed) && (
        <View style={styles.sectionBlock}>
          <Text style={[styles.sectionLabel, { color: 'rgba(239,68,68,0.4)' }]}>DANGER ZONE</Text>
          <View style={[styles.card, { borderColor: 'rgba(239,68,68,0.15)' }]}>
            {vaultConfig.executed ? (
              <TouchableOpacity style={styles.actionRow} onPress={handleCloseExecuted} disabled={isRevoking}>
                <View style={[styles.actionIcon, { backgroundColor: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.25)' }]}>
                  {isRevoking ? (
                    <ActivityIndicator size="small" color="#EF4444" />
                  ) : (
                    <MaterialCommunityIcons name="broom" size={15} color="#EF4444" />
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.actionLabel, { color: '#EF4444', flex: 0 }]}>Close Vault & Reclaim Rent</Text>
                  <Text style={styles.actionDesc}>Estate plan executed. Close on-chain and return rent.</Text>
                </View>
                <MaterialCommunityIcons name="chevron-right" size={14} color="rgba(255,255,255,0.2)" />
              </TouchableOpacity>
            ) : vaultConfig.isMutable === false ? (
              <View style={styles.actionRow}>
                <View style={[styles.actionIcon, { backgroundColor: 'rgba(255,255,255,0.05)', borderColor: 'rgba(255,255,255,0.1)' }]}>
                  <MaterialCommunityIcons name="lock" size={15} color="rgba(255,255,255,0.3)" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.actionLabel, { color: 'rgba(255,255,255,0.3)', flex: 0 }]}>Vault Immutable</Text>
                  <Text style={styles.actionDesc}>This vault cannot be revoked or modified</Text>
                </View>
              </View>
            ) : (
              <TouchableOpacity style={styles.actionRow} onPress={handleRevoke} disabled={isRevoking}>
                <View style={[styles.actionIcon, { backgroundColor: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.25)' }]}>
                  {isRevoking ? (
                    <ActivityIndicator size="small" color="#EF4444" />
                  ) : (
                    <MaterialCommunityIcons name="alert-octagon" size={15} color="#EF4444" />
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.actionLabel, { color: '#EF4444', flex: 0 }]}>Revoke Vault</Text>
                  <Text style={styles.actionDesc}>Deactivates on-chain and clears local data</Text>
                </View>
                <MaterialCommunityIcons name="chevron-right" size={14} color="rgba(255,255,255,0.2)" />
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

function SettingRow({ icon, iconColor, label, value, link }: {
  icon: string;
  iconColor: string;
  label: string;
  value: string;
  link?: boolean;
}) {
  return (
    <View style={styles.settingRow}>
      <View style={[styles.settingIcon, { backgroundColor: iconColor + '15', borderColor: iconColor + '25' }]}>
        <MaterialCommunityIcons name={icon as any} size={15} color={iconColor} />
      </View>
      <View style={styles.settingInfo}>
        <Text style={styles.settingLabel}>{label}</Text>
        {value ? <Text style={[styles.settingValue, link && { color: COLORS.accent }]}>{value}</Text> : null}
      </View>
      {link && <MaterialCommunityIcons name="open-in-new" size={12} color={COLORS.accent} />}
    </View>
  );
}

function ToggleRow({ icon, iconColor, label, description, value, onChange }: {
  icon: string;
  iconColor: string;
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  const thumbAnim = useRef(new Animated.Value(value ? 1 : 0)).current;

  const handleToggle = useCallback(() => {
    const newVal = !value;
    Animated.spring(thumbAnim, { toValue: newVal ? 1 : 0, useNativeDriver: false, friction: 8 }).start();
    onChange(newVal);
  }, [value, onChange, thumbAnim]);

  const thumbLeft = thumbAnim.interpolate({ inputRange: [0, 1], outputRange: [2, 22] });
  const trackColor = thumbAnim.interpolate({ inputRange: [0, 1], outputRange: ['rgba(255,255,255,0.1)', iconColor] });
  const thumbColor = thumbAnim.interpolate({ inputRange: [0, 1], outputRange: ['rgba(255,255,255,0.5)', COLORS.bg] });

  return (
    <View style={styles.toggleRow}>
      <View style={[styles.settingIcon, { backgroundColor: iconColor + '15', borderColor: iconColor + '25' }]}>
        <MaterialCommunityIcons name={icon as any} size={15} color={iconColor} />
      </View>
      <View style={styles.toggleInfo}>
        <Text style={styles.toggleLabel}>{label}</Text>
        {description && <Text style={styles.toggleDesc}>{description}</Text>}
      </View>
      <TouchableOpacity onPress={handleToggle} activeOpacity={0.7}>
        <Animated.View style={[styles.toggleTrack, { backgroundColor: trackColor }]}>
          <Animated.View style={[styles.toggleThumb, { left: thumbLeft, backgroundColor: thumbColor }]} />
        </Animated.View>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { paddingHorizontal: 16 },
  header: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
    fontFamily: FONTS.primaryBold,
    marginTop: 16,
    marginBottom: 20,
  },
  sectionBlock: { marginBottom: 16 },
  sectionLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.3)',
    letterSpacing: 1.2,
    fontFamily: FONTS.primarySemiBold,
    marginBottom: 8,
    paddingLeft: 4,
  },
  card: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    borderRadius: 16,
    overflow: 'hidden',
  },
  rowDivider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  /* Network / custom RPC */
  netRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  netLabel: { fontSize: 13, color: '#FFFFFF', fontFamily: FONTS.primaryMedium },
  netBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  netBadgeText: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.5)',
    fontFamily: FONTS.primarySemiBold,
    letterSpacing: 0.5,
  },
  netEndpoint: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.4)',
    fontFamily: FONTS.mono,
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  netInput: {
    marginHorizontal: 16,
    marginTop: 10,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: '#FFFFFF',
    fontSize: 13,
    fontFamily: FONTS.mono,
  },
  netTestResult: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.55)',
    fontFamily: FONTS.primary,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  netBtnRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  netBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  netBtnPrimary: {
    backgroundColor: 'rgba(0,255,163,0.12)',
    borderColor: 'rgba(0,255,163,0.3)',
  },
  netBtnText: { fontSize: 12, color: 'rgba(255,255,255,0.7)', fontFamily: FONTS.primaryMedium },
  netBtnTextPrimary: { color: COLORS.accent },
  netHelp: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.3)',
    fontFamily: FONTS.primary,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 14,
    lineHeight: 15,
  },
  /* Vault Status */
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusLabelText: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: FONTS.primarySemiBold,
  },
  statusStageBadge: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.3)',
    fontFamily: FONTS.primary,
  },
  statusGrid: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  statusGridCell: {
    flex: 1,
  },
  statusGridCellBorder: {
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
    paddingHorizontal: 12,
  },
  statusGridLabel: {
    fontSize: 9,
    color: 'rgba(255,255,255,0.25)',
    fontFamily: FONTS.primary,
  },
  statusGridValue: {
    fontSize: 12,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.7)',
    fontFamily: FONTS.primarySemiBold,
    marginTop: 2,
  },
  /* Wallet */
  walletRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  walletIcon: {
    width: 32,
    height: 32,
    borderRadius: 12,
    backgroundColor: 'rgba(153,69,255,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(153,69,255,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  walletInfo: { flex: 1 },
  walletLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: '#FFFFFF',
    fontFamily: FONTS.primaryMedium,
  },
  walletAddr: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.3)',
    fontFamily: FONTS.mono,
    marginTop: 1,
  },
  copyBtn: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  copyBtnActive: {
    backgroundColor: 'rgba(0,255,163,0.12)',
    borderColor: 'rgba(0,255,163,0.25)',
  },
  connectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    paddingVertical: 14,
    margin: 16,
  },
  connectBtnText: {
    color: COLORS.bg,
    fontSize: 14,
    fontWeight: '700',
    fontFamily: FONTS.primaryBold,
  },
  /* Action rows */
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  actionIcon: {
    width: 32,
    height: 32,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: {
    fontSize: 13,
    fontWeight: '500',
    fontFamily: FONTS.primaryMedium,
  },
  actionDesc: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.3)',
    fontFamily: FONTS.primary,
    marginTop: 1,
  },
  /* Setting rows */
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  settingIcon: {
    width: 32,
    height: 32,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingInfo: { flex: 1 },
  settingLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: '#FFFFFF',
    fontFamily: FONTS.primaryMedium,
  },
  settingValue: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.3)',
    fontFamily: FONTS.mono,
    marginTop: 1,
  },
  /* Toggle */
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  toggleInfo: { flex: 1 },
  toggleLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: '#FFFFFF',
    fontFamily: FONTS.primaryMedium,
  },
  toggleDesc: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.3)',
    fontFamily: FONTS.primary,
    marginTop: 1,
  },
  toggleTrack: {
    width: 44,
    height: 24,
    borderRadius: 12,
    position: 'relative',
  },
  toggleThumb: {
    position: 'absolute',
    top: 2,
    width: 20,
    height: 20,
    borderRadius: 10,
  },
});
