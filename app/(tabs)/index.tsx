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
const ART_SCAN_BYTES = 1024 * 1024;
const decodeHtml = (str: string) =>
  str.replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

const songTitle = (songName: string) => songName.replace(/\.mp3$/i, '');

const artworkType = (src: string) => {
  const dataUriType = src.match(/^data:(image\/[^;]+);/)?.[1];
  if (dataUriType) return dataUriType;
  if (src.toLowerCase().includes('.png')) return 'image/png';
  return 'image/jpeg';
};

const mediaMetadata = (title: string, art?: string) => new MediaMetadata({
  title,
  artwork: art
    ? [
      { src: art, sizes: '96x96', type: artworkType(art) },
      { src: art, sizes: '128x128', type: artworkType(art) },
      { src: art, sizes: '192x192', type: artworkType(art) },
      { src: art, sizes: '256x256', type: artworkType(art) },
      { src: art, sizes: '512x512', type: artworkType(art) },
    ]
    : undefined,
});

const updateMediaPlaybackState = (playing: boolean, positionMillis?: number, durationMillis?: number) => {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';

  try {
    navigator.mediaSession.setPositionState?.({
      duration: Math.max((durationMillis ?? 1) / 1000, 1),
      playbackRate: 1,
      position: Math.max((positionMillis ?? 0) / 1000, 0),
    });
  } catch {
    // Some iOS versions expose mediaSession but reject position updates.
  }
};

const setMediaActionHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler) => {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch {
    // Safari may expose mediaSession but reject individual actions.
  }
};

const bytesToString = (bytes: Uint8Array, start: number, end: number) => {
  let value = '';
  for (let i = start; i < end; i++) value += String.fromCharCode(bytes[i]);
  return value;
};

const readSynchsafeInt = (bytes: Uint8Array, start: number) =>
  ((bytes[start] & 0x7f) << 21)
  | ((bytes[start + 1] & 0x7f) << 14)
  | ((bytes[start + 2] & 0x7f) << 7)
  | (bytes[start + 3] & 0x7f);

const readFrameSize = (bytes: Uint8Array, start: number, version: number) => {
  if (version === 4) return readSynchsafeInt(bytes, start);
  return (bytes[start] << 24) | (bytes[start + 1] << 16) | (bytes[start + 2] << 8) | bytes[start + 3];
};

const findTextEnd = (bytes: Uint8Array, start: number, end: number, encoding: number) => {
  const step = encoding === 1 || encoding === 2 ? 2 : 1;
  for (let i = start; i < end - step + 1; i += step) {
    if (step === 2 && bytes[i] === 0 && bytes[i + 1] === 0) return i + 2;
    if (step === 1 && bytes[i] === 0) return i + 1;
  }
  return -1;
};

const uint8ArrayToBase64 = (bytes: Uint8Array) => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};

const extractEmbeddedAlbumArt = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 10 || bytesToString(bytes, 0, 3) !== 'ID3') return null;

  const version = bytes[3];
  if (version < 3 || version > 4) return null;

  const tagEnd = Math.min(bytes.length, 10 + readSynchsafeInt(bytes, 6));
  let offset = 10;

  while (offset + 10 <= tagEnd) {
    const frameId = bytesToString(bytes, offset, offset + 4);
    const frameSize = readFrameSize(bytes, offset + 4, version);
    const frameStart = offset + 10;
    const frameEnd = frameStart + frameSize;

    if (!frameId.trim() || frameSize <= 0 || frameEnd > tagEnd) break;

    if (frameId === 'APIC') {
      const encoding = bytes[frameStart];
      const mimeEnd = bytes.indexOf(0, frameStart + 1);
      if (mimeEnd === -1 || mimeEnd + 2 >= frameEnd) return null;

      const mime = bytesToString(bytes, frameStart + 1, mimeEnd) || 'image/jpeg';
      const descriptionStart = mimeEnd + 2;
      const imageStart = findTextEnd(bytes, descriptionStart, frameEnd, encoding);
      if (imageStart === -1 || imageStart >= frameEnd) return null;

      const imageBytes = bytes.subarray(imageStart, frameEnd);
      return `data:${mime};base64,${uint8ArrayToBase64(imageBytes)}`;
    }

    offset = frameEnd;
  }

  return null;
};

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
  const isPlayingRef = useRef(false);
  const positionRef = useRef(0);
  const durationRef = useRef(1);
  const spinAnim = useRef(new Animated.Value(0)).current;
  const spinLoop = useRef<Animated.CompositeAnimation | null>(null);
  const mediaHeartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { positionRef.current = position; }, [position]);
  useEffect(() => { durationRef.current = duration; }, [duration]);

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

  const fetchEmbeddedAlbumArt = async (songKey: string) => {
    try {
      const res = await fetch(`${BUCKET_URL}/${encodeURIComponent(songKey)}`, {
        headers: { Range: `bytes=0-${ART_SCAN_BYTES - 1}` },
      });
      const art = extractEmbeddedAlbumArt(await res.arrayBuffer());
      if (art) {
        setArtCache(prev => ({
          ...prev,
          [songTitle(songKey)]: art,
        }));
        return art;
      }
    } catch {
      // ignore
    }

    return null;
  };

  const fetchDeezerAlbumArt = async (songName: string) => {
    try {
      const clean = songName
        .replace(/\.mp3$/i, '')
        .replace(/\(.*?\)/g, '')
        .trim();
      const res = await fetch(
        `https://api.deezer.com/search?q=${encodeURIComponent(clean)}&limit=1`
      );
      const data = await res.json();
      const art = data?.data?.[0]?.album?.cover_xl
        || data?.data?.[0]?.album?.cover_big
        || data?.data?.[0]?.album?.cover_medium;
      if (art) {
        setArtCache(prev => ({
          ...prev,
          [songTitle(songName)]: art,
        }));
      }
    } catch {
      // ignore
    }
  };

  const fetchAlbumArt = async (songKey: string) => {
    const embeddedArt = await fetchEmbeddedAlbumArt(songKey);
    if (!embeddedArt) await fetchDeezerAlbumArt(songKey);
  };

  const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

  const loadArtsSequentially = async (names: string[]) => {
    for (let i = 0; i < names.length; i++) {
      await fetchAlbumArt(names[i]);

      // small delay prevents public art services from throttling fallback requests
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
    isPlayingRef.current = status.isPlaying;
    setIsPlaying(status.isPlaying);
    updateMediaPlaybackState(status.isPlaying, status.positionMillis, status.durationMillis || 1);
    if (status.didJustFinish) {
      const nextIdx = getNextIndex(currentIndexRef.current);
      playSong(nextIdx);
    }
  }, []);
  const currentSongRef = useRef<string | null>(null);
  const updateMediaSession = (index: number, playing = isPlayingRef.current) => {
    if (!('mediaSession' in navigator)) return;

    const key = songsRef.current[index];
    const title = key ? songTitle(key) : 'Unknown';
    const art = key ? artCache[songTitle(key)] : undefined;

    navigator.mediaSession.metadata = mediaMetadata(title, art);
    registerMediaSession();
    updateMediaPlaybackState(playing, positionRef.current, durationRef.current);
  };

  const registerMediaSession = () => {
    if (!('mediaSession' in navigator)) return;

    setMediaActionHandler('nexttrack', handleNext);
    setMediaActionHandler('previoustrack', handlePrev);

    setMediaActionHandler('play', async () => {
      await soundRef.current?.playAsync();
      isPlayingRef.current = true;
      setIsPlaying(true);
      updateMediaPlaybackState(true, positionRef.current, durationRef.current);
    });

    setMediaActionHandler('pause', async () => {
      await soundRef.current?.pauseAsync();
      isPlayingRef.current = false;
      setIsPlaying(false);
      updateMediaPlaybackState(false, positionRef.current, durationRef.current);
    });
  };

  useEffect(() => {
    updateMediaPlaybackState(isPlaying, position, duration);
  }, [isPlaying, position, duration]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const key = songs[currentIndex];
    const title = key ? songTitle(key) : '';
    const art = key ? artCache[songTitle(key)] : undefined;
    navigator.mediaSession.metadata = mediaMetadata(title, art);
    registerMediaSession();
    updateMediaPlaybackState(isPlayingRef.current, positionRef.current, durationRef.current);
  }, [currentIndex, songs, artCache]);

  useEffect(() => {
    if (mediaHeartbeatRef.current) {
      clearInterval(mediaHeartbeatRef.current);
      mediaHeartbeatRef.current = null;
    }

    if (isPlaying) {
      mediaHeartbeatRef.current = setInterval(() => {
        updateMediaPlaybackState(true, positionRef.current, durationRef.current);
      }, 1000);
    }

    return () => {
      if (mediaHeartbeatRef.current) {
        clearInterval(mediaHeartbeatRef.current);
        mediaHeartbeatRef.current = null;
      }
    };
  }, [isPlaying]);
  
  const playSong = async (index: number) => {
    // 🟡 prevent reloading same song unnecessarily
    if (currentIndexRef.current === index && soundRef.current) {
      try {
        await soundRef.current.playAsync();
        isPlayingRef.current = true;
        setIsPlaying(true);
        updateMediaPlaybackState(true, positionRef.current, durationRef.current);
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
    if (key && !artCache[songTitle(key)]) fetchAlbumArt(key);

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

    isPlayingRef.current = true;
    setIsPlaying(true);
    registerMediaSession();
    updateMediaSession(index, true);

    // safer preload timing for iOS
    setTimeout(() => preloadNext(index), 200);
  };

  const startPlaying = () => {
    const library = songsRef.current;
    if (!library.length) return;

    setIsShuffled(true);
    isShuffledRef.current = true;
    playSong(Math.floor(Math.random() * library.length));
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
        isPlayingRef.current = false;
        setIsPlaying(false);
        updateMediaPlaybackState(false, positionRef.current, durationRef.current);
      } catch { }
    } else {
      try {
        await soundRef.current.playAsync();
        isPlayingRef.current = true;
        setIsPlaying(true);
        updateMediaPlaybackState(true, positionRef.current, durationRef.current);
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

      <TouchableOpacity
        style={[styles.startButton, !songs.length && styles.startButtonDisabled]}
        onPress={startPlaying}
        disabled={!songs.length}
        activeOpacity={0.85}
      >
        <Text style={styles.startButtonText}>Start Playing</Text>
      </TouchableOpacity>

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
  startButton: {
    marginHorizontal: 20, marginTop: 6, marginBottom: 8, paddingVertical: 14,
    borderRadius: 14, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center', ...neu,
  },
  startButtonDisabled: { opacity: 0.5 },
  startButtonText: { color: '#fff', fontSize: 16, fontWeight: '800' },
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
