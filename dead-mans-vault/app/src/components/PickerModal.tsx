import React from 'react';
import {
  View,
  Text,
  Image,
  Modal,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, FONTS } from '../utils/constants';

export interface PickerOption {
  key: string;
  label: string;
  sublabel?: string;      // right-aligned (e.g. balance held, or share %)
  badge?: string;         // e.g. 'NFT'
  image?: string | null;  // thumbnail (NFTs)
  warn?: boolean;         // show a compact issuer-risk indicator
}

interface PickerModalProps {
  visible: boolean;
  title: string;
  options: PickerOption[];
  selectedKey: string;
  onSelect: (key: string) => void;
  onClose: () => void;
}

/** A simple, discoverable selection modal — a scrollable list of options with an
 *  optional thumbnail, badge, right-aligned sublabel and a check on the current
 *  choice. Used by the Bequests screen for both asset and beneficiary selection. */
export function PickerModal({ visible, title, options, selectedKey, onSelect, onClose }: PickerModalProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} />
        <View style={styles.container}>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <MaterialCommunityIcons name="close" size={20} color="rgba(255,255,255,0.5)" />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
            {options.map((o) => {
              const selected = o.key === selectedKey;
              return (
                <TouchableOpacity
                  key={o.key}
                  style={[styles.row, selected && styles.rowSelected]}
                  onPress={() => { onSelect(o.key); onClose(); }}
                >
                  {o.image ? (
                    <Image source={{ uri: o.image }} style={styles.thumb} />
                  ) : (
                    <View style={styles.thumbFallback}>
                      <Text style={styles.thumbFallbackText}>{(o.label || '?').slice(0, 1).toUpperCase()}</Text>
                    </View>
                  )}
                  <View style={styles.textCol}>
                    <View style={styles.labelRow}>
                      <Text style={styles.label} numberOfLines={1}>{o.label}</Text>
                      {o.badge ? <Text style={styles.badge}>{o.badge}</Text> : null}
                    </View>
                    {o.warn ? <Text style={styles.warn}>⚠ issuer-controlled</Text> : null}
                  </View>
                  {o.sublabel ? <Text style={styles.sublabel}>{o.sublabel}</Text> : null}
                  <MaterialCommunityIcons
                    name={selected ? 'check-circle' : 'checkbox-blank-circle-outline'}
                    size={18}
                    color={selected ? COLORS.accent : 'rgba(255,255,255,0.18)'}
                    style={styles.check}
                  />
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.7)' },
  container: {
    width: '88%',
    maxWidth: 380,
    maxHeight: '70%',
    backgroundColor: COLORS.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    paddingVertical: 18,
    paddingHorizontal: 18,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { fontSize: 16, fontWeight: '700', color: '#FFFFFF', fontFamily: FONTS.primaryBold },
  list: { flexGrow: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'transparent',
    marginBottom: 6,
  },
  rowSelected: { borderColor: COLORS.accent, backgroundColor: 'rgba(0,255,163,0.08)' },
  thumb: { width: 34, height: 34, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.06)' },
  thumbFallback: {
    width: 34, height: 34, borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center', justifyContent: 'center',
  },
  thumbFallbackText: { color: 'rgba(255,255,255,0.6)', fontSize: 14, fontFamily: FONTS.primaryBold },
  textCol: { flex: 1 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { color: '#FFFFFF', fontSize: 14, fontFamily: FONTS.primarySemiBold, flexShrink: 1 },
  badge: {
    color: COLORS.accent, fontSize: 10, fontFamily: FONTS.primaryBold,
    borderWidth: 1, borderColor: 'rgba(0,255,163,0.3)', borderRadius: 6,
    paddingHorizontal: 5, paddingVertical: 1, overflow: 'hidden',
  },
  warn: { color: COLORS.warning, fontSize: 11, fontFamily: FONTS.primary, marginTop: 2 },
  sublabel: { color: 'rgba(255,255,255,0.6)', fontSize: 12.5, fontFamily: FONTS.mono },
  check: { marginLeft: 2 },
});
