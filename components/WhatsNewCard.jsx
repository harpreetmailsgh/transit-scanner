import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

const GO_GREEN = '#00853F';

// One-time card shown after the v1.2 update: tells a returning user the
// two new things, then goes away. The parent owns when it shows and what
// "Got it" means (seen flag + hide) — this component only renders the
// card and calls onGotIt() when the button is tapped. No storage, no
// navigation, no network in here.
export default function WhatsNewCard({ visible, onGotIt }) {
  return (
    <Modal transparent animationType="fade" visible={visible}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.strip} />
          <Text style={styles.headline}>Your app has been updated</Text>
          <View style={styles.bulletRow}>
            <Text style={styles.tick}>✓</Text>
            <Text style={styles.bulletText}>More accurate live times now</Text>
          </View>
          <View style={styles.bulletRow}>
            <Text style={styles.tick}>✓</Text>
            <Text style={styles.bulletText}>Destination alert: we&apos;ll buzz you one stop before yours. Hit Track on any stop on Trip Details screen.</Text>
          </View>
          <Text style={styles.closer}>We hope you enjoy the new updates.</Text>
          <Pressable style={styles.button} onPress={onGotIt}>
            <Text style={styles.buttonText}>Got it</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    width: '85%',
    height: '50%',
    backgroundColor: '#ffffff',
    borderRadius: 16,
    overflow: 'hidden',
    paddingHorizontal: 20,
    paddingBottom: 20,
  },
  strip: {
    height: 6,
    backgroundColor: GO_GREEN,
    marginHorizontal: -20,
    marginBottom: 20,
  },
  headline: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1a1a1a',
    textAlign: 'center',
    marginBottom: 20,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 14,
  },
  tick: {
    fontSize: 16,
    fontWeight: '700',
    color: GO_GREEN,
    marginRight: 10,
  },
  bulletText: {
    flex: 1,
    fontSize: 16,
    color: '#1a1a1a',
    lineHeight: 22,
  },
  closer: {
    fontSize: 15,
    color: '#555555',
    textAlign: 'center',
    marginTop: 8,
  },
  button: {
    backgroundColor: GO_GREEN,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 'auto',
  },
  buttonText: {
    fontSize: 17,
    fontWeight: '600',
    color: '#ffffff',
  },
});
