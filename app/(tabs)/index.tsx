import { useEffect, useState, useRef, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  SafeAreaView, TextInput, Animated, Modal, StatusBar, Image, Platform
} from 'react-native';
import { Audio, AVPlaybackStatus } from 'expo-av';
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
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(1);
  const [isSeeking, setIsSeeking] = useState(false);
  const [isShuffled, setIsShuffled] = useState(false);
  const [showPlayer, setShowPlayer] = useState(false);
  const [artCache, setArtCache] = useState<Record<string, string>>({});

  const soundRef = useRef<Audio.Sound | null>(null);
  const preloadedRef = useRef<{ sound: Audio.Sound; index: number } | null>(null);
  const currentIndexRef = useRef(-1);
  const songsRef = useRef<string[]>([]);
  const isShuffledRef = useRef(false);
  const isSeekingRef = useRef(false);
  const spinAnim = useRef(new Animated.Value(0)).current;
  const spinLoop = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      shouldDuckAndroid: false,
    });
    fetchSongs();
  }, []);

  useEffect(() => { songsRef.current = songs; }, [songs]);
  useEffect(() => { isShuffledRef.current = isShuffled; }, [isShuffled]);
  useEffect(() => { isSeekingRef.current = isSeeking; }, [isSeeking]);

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

  const fetchAlbumArt = async (songName: string) => {
    try {
      const clean = songName
        .replace(/\.mp3$/i, '')
        .replace(/\(.*?\)/g, '')
        .trim();
      const res = await fetch(
        `https://itunes.apple.com/search?term=${encodeURIComponent(clean)}&entity=song&limit=1`
      );
      const data = await res.json();
      const art = data?.results?.[0]?.artworkUrl100;
      if (art) {
        setArtCache(prev => ({
          ...prev,
          [songName]: art.replace('100x100', '300x300'),
        }));
      }
    } catch {
      // ignore
    }
  };

  const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

  const loadArtsSequentially = async (names: string[]) => {
    for (let i = 0; i < names.length; i++) {
      const name = names[i].replace('.mp3', '');

      await fetchAlbumArt(name);

      // small delay prevents iTunes rate limit
      await sleep(120);
    }
  };
  const fetchSongs = async () => {
    const res = await fetch(`${BUCKET_URL}?list-type=2`);
    const text = await res.text();
    const matches = [...text.matchAll(/<Key>(.+?\.mp3)<\/Key>/g)];
    const names = matches.map(m => decodeHtml(m[1])).filter(k => k.endsWith('.mp3'));
    setSongs(names);
    setFiltered(names);

    // load only first 15 immediately
    loadArtsSequentially(names.slice(0, 15));

    // lazy-load the rest in background
    setTimeout(() => {
      loadArtsSequentially(names.slice(15));
    }, 2000);
  };

  const getNextIndex = (index: number) => {
    const s = songsRef.current;
    if (isShuffledRef.current) return Math.floor(Math.random() * s.length);
    return (index + 1) % s.length;
  };

  const preloadNext = async (index: number) => {
    const nextIdx = getNextIndex(index);
    const key = songsRef.current[nextIdx];
    if (!key) return;
    try {
      if (preloadedRef.current && preloadedRef.current.index !== nextIdx) {
        await preloadedRef.current.sound.unloadAsync();
        preloadedRef.current = null;
      }
      if (preloadedRef.current?.index === nextIdx) return;
      const { sound } = await Audio.Sound.createAsync(
        { uri: `${BUCKET_URL}/${encodeURIComponent(key)}` },
        { shouldPlay: false }
      );
      preloadedRef.current = { sound, index: nextIdx };
    } catch { }
  };

  const onPlaybackStatusUpdate = useCallback((status: AVPlaybackStatus) => {
    if (!status.isLoaded) return;
    if (!isSeekingRef.current) setPosition(status.positionMillis);
    setDuration(status.durationMillis || 1);
    if (status.didJustFinish) {
      const nextIdx = getNextIndex(currentIndexRef.current);
      playSong(nextIdx);
    }
  }, []);
  const currentSongRef = useRef<string | null>(null);
  const updateMediaSession = (index: number) => {
    if (!('mediaSession' in navigator)) return;

    const title = songsRef.current[index]?.replace('.mp3', '') ?? 'Unknown';

    navigator.mediaSession.metadata = new MediaMetadata({
      title,
    });
  };

  const registerMediaSession = () => {
    if (!('mediaSession' in navigator)) return;

    navigator.mediaSession.setActionHandler('nexttrack', handleNext);
    navigator.mediaSession.setActionHandler('previoustrack', handlePrev);

    navigator.mediaSession.setActionHandler('play', async () => {
      await soundRef.current?.playAsync();
      setIsPlaying(true);
    });

    navigator.mediaSession.setActionHandler('pause', async () => {
      await soundRef.current?.pauseAsync();
      setIsPlaying(false);
    });
  };

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const title = songs[currentIndex]?.replace('.mp3', '') ?? '';
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
    });
  }, [currentIndex]);
  
  const playSong = async (index: number) => {
    // 🟡 prevent reloading same song unnecessarily
    if (currentIndexRef.current === index && soundRef.current) {
      try {
        await soundRef.current.playAsync();
        setIsPlaying(true);
      } catch { }
      return;
    }

    // ❌ IMPORTANT FIX: do NOT unload on iOS (breaks lock/background audio)
    if (soundRef.current) {
      try {
        await soundRef.current.pauseAsync();
      } catch { }
    }

    setPosition(0);
    currentIndexRef.current = index;
    setCurrentIndex(index);

    const key = songsRef.current[index];
    currentSongRef.current = key?.replace('.mp3', '') ?? '';

    let newSound: Audio.Sound;

    // reuse preload if available
    if (preloadedRef.current?.index === index) {
      newSound = preloadedRef.current.sound;
      preloadedRef.current = null;
      await newSound.playAsync();
    } else {
      if (preloadedRef.current) {
        try {
          await preloadedRef.current.sound.unloadAsync();
        } catch { }
        preloadedRef.current = null;
      }

      const { sound } = await Audio.Sound.createAsync(
        { uri: `${BUCKET_URL}/${encodeURIComponent(key)}` },
        { shouldPlay: true }
      );

      newSound = sound;
    }

    newSound.setOnPlaybackStatusUpdate(onPlaybackStatusUpdate);
    soundRef.current = newSound;

    setIsPlaying(true);
    registerMediaSession();
    updateMediaSession(index);

    // safer preload timing for iOS
    setTimeout(() => preloadNext(index), 200);
  };

  const handleNext = () => {
    if (!songsRef.current.length) return;
    playSong(getNextIndex(currentIndexRef.current));
  };

  const handlePrev = () => {
    if (!songsRef.current.length) return;

    if (position > 3000) {
      soundRef.current?.setPositionAsync(0);
      setPosition(0);
      return;
    }

    const prev =
      currentIndexRef.current <= 0
        ? songsRef.current.length - 1
        : currentIndexRef.current - 1;

    playSong(prev);
  };

  const togglePause = async () => {
    if (!soundRef.current) return;

    if (isPlaying) {
      try {
        await soundRef.current.pauseAsync();
        setIsPlaying(false);
      } catch { }
    } else {
      try {
        await soundRef.current.playAsync();
        setIsPlaying(true);
      } catch { }
    }
  };



  const formatTime = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
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
              {art ? (
                <Image source={{ uri: art }} style={styles.songArt} />
              ) : (
                <View style={[styles.songArt, styles.songArtPlaceholder]} />
              )}
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
              maximumValue={duration}
              value={position}
              minimumTrackTintColor={ACCENT}
              maximumTrackTintColor={SHADOW_DARK}
              thumbTintColor={ACCENT}
              onSlidingStart={() => setIsSeeking(true)}
              onSlidingComplete={async (val) => {
                setIsSeeking(false);
                await soundRef.current?.setPositionAsync(val);
                setPosition(val);
              }}
            />
            <View style={styles.timeRow}>
              <Text style={styles.timeText}>{formatTime(position)}</Text>
              <Text style={styles.timeText}>{formatTime(duration)}</Text>
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
