import { useEffect, useState, useRef, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  SafeAreaView, TextInput, Animated, Modal, StatusBar, Image
} from 'react-native';
import TrackPlayer, {
  usePlaybackState,
  useProgress,
  State,
  Event,
  RepeatMode,
  Capability,
} from 'react-native-track-player';
import Slider from '@react-native-community/slider';

const BUCKET_URL = 'https://zezo-alexa-audio.s3.amazonaws.com';
const BG = '#e0e5ec';
const SHADOW_DARK = '#a3b1c6';
const ACCENT = '#6c8ebf';
const TEXT = '#2d3748';
const TEXT_DIM = '#7a8ba0';

const decodeHtml = (str: string) =>
  str.replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

export default function App() {
  const [songs, setSongs] = useState<string[]>([]);
  const [filtered, setFiltered] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [isShuffled, setIsShuffled] = useState(false);
  const [showPlayer, setShowPlayer] = useState(false);
  const [artCache, setArtCache] = useState<Record<string, string>>({});
  const [isReady, setIsReady] = useState(false);

  const playbackState = usePlaybackState();
  const progress = useProgress();
  const isPlaying = playbackState.state === State.Playing;

  const songsRef = useRef<string[]>([]);
  const spinAnim = useRef(new Animated.Value(0)).current;
  const spinLoop = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    setupPlayer();
  }, []);

  useEffect(() => { songsRef.current = songs; }, [songs]);

  useEffect(() => {
    if (search.trim() === '') setFiltered(songs);
    else setFiltered(songs.filter(s => s.replace('.mp3', '').toLowerCase().includes(search.toLowerCase())));
  }, [search, songs]);

  useEffect(() => {
    if (isPlaying) {
      spinLoop.current = Animated.loop(Animated.timing(spinAnim, { toValue: 1, duration: 6000, useNativeDriver: true }));
      spinLoop.current.start();
    } else {
      spinLoop.current?.stop();
    }
  }, [isPlaying]);

  const setupPlayer = async () => {
    try {
      await TrackPlayer.setupPlayer();
      await TrackPlayer.updateOptions({
        capabilities: [
          Capability.Play,
          Capability.Pause,
          Capability.SkipToNext,
          Capability.SkipToPrevious,
          Capability.Stop,
        ],
        compactCapabilities: [
          Capability.Play,
          Capability.Pause,
          Capability.SkipToNext,
        ],
      });
      setIsReady(true);
      fetchSongs();
    } catch (e) {
      console.log('Player setup error:', e);
    }
  };

  const fetchAlbumArt = async (songName: string) => {
    try {
      const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(songName)}&entity=song&limit=1`);
      const data = await res.json();
      if (data.results?.length > 0) {
        const art = data.results[0].artworkUrl100.replace('100x100', '300x300');
        setArtCache(prev => ({ ...prev, [songName]: art }));
      }
    } catch { }
  };

  const fetchSongs = async () => {
    const res = await fetch(`${BUCKET_URL}?list-type=2`);
    const text = await res.text();
    const matches = [...text.matchAll(/<Key>(.+?\.mp3)<\/Key>/g)];
    const names = matches.map(m => decodeHtml(m[1])).filter(k => k.endsWith('.mp3'));
    setSongs(names);
    setFiltered(names);
    names.forEach(n => fetchAlbumArt(n.replace('.mp3', '')));
  };

  const playSong = async (index: number) => {
    if (!isReady) return;
    const key = songsRef.current[index];
    if (!key) return;

    const songName = key.replace('.mp3', '');
    const art = artCache[songName];

    await TrackPlayer.reset();

    const queue = songsRef.current.map((s, i) => ({
      id: String(i),
      url: `${BUCKET_URL}/${encodeURIComponent(s)}`,
      title: s.replace('.mp3', ''),
      artist: 'ZeZo Audio',
      artwork: artCache[s.replace('.mp3', '')] || undefined,
    }));

    await TrackPlayer.add(queue);
    await TrackPlayer.skip(index);
    await TrackPlayer.play();
    setCurrentIndex(index);

    if (isShuffled) {
      await TrackPlayer.setRepeatMode(RepeatMode.Queue);
    }
  };

  const handleNext = async () => {
    await TrackPlayer.skipToNext();
    const track = await TrackPlayer.getActiveTrackIndex();
    if (track !== undefined && track !== null) setCurrentIndex(track);
  };

  const handlePrev = async () => {
    if (progress.position > 3) {
      await TrackPlayer.seekTo(0);
      return;
    }
    await TrackPlayer.skipToPrevious();
    const track = await TrackPlayer.getActiveTrackIndex();
    if (track !== undefined && track !== null) setCurrentIndex(track);
  };

  const togglePause = async () => {
    if (isPlaying) {
      await TrackPlayer.pause();
    } else {
      await TrackPlayer.play();
    }
  };

  const formatTime = (s: number) => {
    const secs = Math.floor(s);
    return `${Math.floor(secs / 60)}:${(secs % 60).toString().padStart(2, '0')}`;
  };

  const spin = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const currentSong = currentIndex >= 0 ? songs[currentIndex]?.replace('.mp3', '') : null;
  const currentArt = currentSong ? artCache[currentSong] : null;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.searchWrapper}>
        <TextInput
          style={styles.search}
          placeholder="Search songs..."
          placeholderTextColor={TEXT_DIM}
          value={search}
          onChangeText={setSearch}
        />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={item => item}
        contentContainerStyle={{ paddingBottom: currentSong ? 100 : 20 }}
        renderItem={({ item }) => {
          const isActive = songs[currentIndex] === item;
          const songName = item.replace('.mp3', '');
          const art = artCache[songName];
          return (
            <TouchableOpacity
              style={[styles.song, isActive && styles.songActive]}
              onPress={() => playSong(songs.indexOf(item))}
            >
              {art
                ? <Image source={{ uri: art }} style={styles.songArt} />
                : <View style={[styles.songArt, styles.songArtPlaceholder]} />
              }
              <Text style={[styles.songText, isActive && styles.songTextActive]} numberOfLines={1}>
                {songName}
              </Text>
              {isActive && <Text style={styles.playingIndicator}>♫</Text>}
            </TouchableOpacity>
          );
        }}
      />

      {currentSong && (
        <TouchableOpacity style={styles.miniPlayer} onPress={() => setShowPlayer(true)} activeOpacity={0.9}>
          {currentArt
            ? <Image source={{ uri: currentArt }} style={styles.miniArt} />
            : (
              <Animated.View style={[styles.miniDisc, { transform: [{ rotate: spin }] }]}>
                <View style={styles.miniDiscInner} />
              </Animated.View>
            )
          }
          <Text style={styles.miniSongName} numberOfLines={1}>{currentSong}</Text>
          <TouchableOpacity
            style={[styles.miniShuffleBtn, isShuffled && styles.activeBg]}
            onPress={() => setIsShuffled(p => !p)}
          >
            <Text style={styles.miniCtrlText}>🔀</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={togglePause} style={styles.miniPlayBtn}>
            <Text style={styles.miniPlayText}>{isPlaying ? '⏸' : '▶️'}</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      )}

      <Modal
        visible={showPlayer}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowPlayer(false)}
      >
        <SafeAreaView style={styles.modalContainer}>
          <TouchableOpacity style={styles.closeBtn} onPress={() => setShowPlayer(false)}>
            <Text style={styles.closeBtnText}>⌄</Text>
          </TouchableOpacity>

          <View style={styles.bigArtWrapper}>
            {currentArt ? (
              <Image source={{ uri: currentArt }} style={styles.bigArt} />
            ) : (
              <Animated.View style={[styles.bigDisc, { transform: [{ rotate: spin }] }]}>
                <View style={styles.bigDiscInner} />
              </Animated.View>
            )}
          </View>

          <Text style={styles.fullSongName} numberOfLines={2}>{currentSong}</Text>

          <View style={styles.progressWrapper}>
            <Slider
              style={styles.slider}
              minimumValue={0}
              maximumValue={progress.duration || 1}
              value={progress.position}
              minimumTrackTintColor={ACCENT}
              maximumTrackTintColor={SHADOW_DARK}
              thumbTintColor={ACCENT}
              onSlidingComplete={async (val) => {
                await TrackPlayer.seekTo(val);
              }}
            />
            <View style={styles.timeRow}>
              <Text style={styles.timeText}>{formatTime(progress.position)}</Text>
              <Text style={styles.timeText}>{formatTime(progress.duration)}</Text>
            </View>
          </View>

          <View style={styles.controlsWrapper}>
            <View style={styles.controls}>
              <TouchableOpacity style={styles.ctrlBtn} onPress={handlePrev}>
                <Text style={styles.ctrlText}>⏮</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.ctrlBtn, styles.playBtn]} onPress={togglePause}>
                <Text style={styles.ctrlTextLarge}>{isPlaying ? '⏸' : '▶️'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.ctrlBtn} onPress={handleNext}>
                <Text style={styles.ctrlText}>⏭</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              style={[styles.shuffleBtn, isShuffled && styles.activeBg]}
              onPress={() => setIsShuffled(p => !p)}
            >
              <Text style={styles.ctrlText}>🔀</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const neu = {
  shadowColor: SHADOW_DARK,
  shadowOffset: { width: 4, height: 4 },
  shadowOpacity: 0.6,
  shadowRadius: 8,
  elevation: 6,
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  searchWrapper: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  search: { backgroundColor: BG, borderRadius: 16, padding: 12, color: TEXT, fontSize: 16, ...neu },
  song: {
    flexDirection: 'row', alignItems: 'center', padding: 12,
    marginHorizontal: 20, marginVertical: 4, borderRadius: 12,
    backgroundColor: BG, gap: 12, ...neu,
  },
  songActive: { backgroundColor: ACCENT },
  songArt: { width: 44, height: 44, borderRadius: 8 },
  songArtPlaceholder: { backgroundColor: SHADOW_DARK },
  songText: { color: TEXT, fontSize: 15, flex: 1 },
  songTextActive: { color: '#fff', fontWeight: '700' },
  playingIndicator: { color: '#fff', fontSize: 16 },
  miniPlayer: {
    position: 'absolute', bottom: 20, left: 20, right: 20,
    backgroundColor: BG, borderRadius: 20, padding: 12,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    shadowColor: SHADOW_DARK, shadowOffset: { width: 6, height: 6 },
    shadowOpacity: 0.6, shadowRadius: 12, elevation: 16,
  },
  miniArt: { width: 40, height: 40, borderRadius: 8 },
  miniDisc: { width: 40, height: 40, borderRadius: 20, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center' },
  miniDiscInner: { width: 12, height: 12, borderRadius: 6, backgroundColor: BG },
  miniSongName: { flex: 1, color: TEXT, fontSize: 14, fontWeight: '600' },
  miniShuffleBtn: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: BG,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: SHADOW_DARK, shadowOffset: { width: 3, height: 3 }, shadowOpacity: 0.5, shadowRadius: 4, elevation: 4,
  },
  miniPlayBtn: { padding: 4 },
  miniPlayText: { fontSize: 22 },
  miniCtrlText: { fontSize: 16 },
  activeBg: { backgroundColor: ACCENT },
  modalContainer: { flex: 1, backgroundColor: BG, paddingHorizontal: 24 },
  closeBtn: { alignSelf: 'center', paddingVertical: 8 },
  closeBtnText: { fontSize: 32, color: TEXT_DIM },
  bigArtWrapper: { alignItems: 'center', marginTop: 20, marginBottom: 32 },
  bigArt: { width: 260, height: 260, borderRadius: 20 },
  bigDisc: {
    width: 260, height: 260, borderRadius: 130, backgroundColor: ACCENT,
    alignItems: 'center', justifyContent: 'center', ...neu,
  },
  bigDiscInner: { width: 70, height: 70, borderRadius: 35, backgroundColor: BG },
  fullSongName: { fontSize: 24, fontWeight: '800', color: TEXT, textAlign: 'center', marginBottom: 24 },
  progressWrapper: { marginBottom: 32, paddingHorizontal: 24 },
  slider: { width: '100%' },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 4, marginTop: -8 },
  timeText: { color: TEXT_DIM, fontSize: 12 },
  controlsWrapper: { alignItems: 'center', gap: 16 },
  controls: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 20 },
  ctrlBtn: { width: 52, height: 52, borderRadius: 26, backgroundColor: BG, alignItems: 'center', justifyContent: 'center', ...neu },
  playBtn: { width: 64, height: 64, borderRadius: 32 },
  ctrlText: { fontSize: 20 },
  ctrlTextLarge: { fontSize: 28 },
  shuffleBtn: { width: 52, height: 52, borderRadius: 26, backgroundColor: BG, alignItems: 'center', justifyContent: 'center', ...neu },
});