import { create } from 'zustand';
import type { DensityMode, ThemeMode } from '../types';

const THEME_STORAGE_KEY = 'open-weight-chat.theme';
const DENSITY_STORAGE_KEY = 'open-weight-chat.density';
const MOTION_STORAGE_KEY = 'open-weight-chat.reduce-motion';

function initialTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'light';
}

function initialDensity(): DensityMode {
  if (typeof window === 'undefined') return 'comfortable';
  return window.localStorage.getItem(DENSITY_STORAGE_KEY) === 'compact' ? 'compact' : 'comfortable';
}

function initialReduceMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(MOTION_STORAGE_KEY) === 'true';
}

interface SettingsState {
  theme: ThemeMode;
  density: DensityMode;
  reduceMotion: boolean;
  setTheme: (theme: ThemeMode) => void;
  setDensity: (density: DensityMode) => void;
  setReduceMotion: (reduceMotion: boolean) => void;
  toggleTheme: () => void;
  resetPreferences: () => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  theme: initialTheme(),
  density: initialDensity(),
  reduceMotion: initialReduceMotion(),
  setTheme: (theme) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    set({ theme });
  },
  setDensity: (density) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(DENSITY_STORAGE_KEY, density);
    set({ density });
  },
  setReduceMotion: (reduceMotion) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(MOTION_STORAGE_KEY, String(reduceMotion));
    set({ reduceMotion });
  },
  toggleTheme: () => {
    const theme = get().theme === 'dark' ? 'light' : 'dark';
    if (typeof window !== 'undefined') window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    set({ theme });
  },
  resetPreferences: () => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
      window.localStorage.removeItem(DENSITY_STORAGE_KEY);
      window.localStorage.removeItem(MOTION_STORAGE_KEY);
    }
    set({ theme: 'light', density: 'comfortable', reduceMotion: false });
  },
}));
