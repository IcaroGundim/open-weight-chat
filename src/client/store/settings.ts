import { create } from 'zustand';
import { isEffortLevel } from '../types';
import type { DensityMode, EffortLevel, ThemeMode } from '../types';

const THEME_STORAGE_KEY = 'open-weight-chat.theme';
const DENSITY_STORAGE_KEY = 'open-weight-chat.density';
const MOTION_STORAGE_KEY = 'open-weight-chat.reduce-motion';
const EFFORT_STORAGE_KEY = 'open-weight-chat.default-effort';
const ARTIFACT_WIDTH_STORAGE_KEY = 'open-weight-chat.artifact-width';
const WEB_SEARCH_STORAGE_KEY = 'open-weight-chat.web-search';

/**
 * Largura do painel de artefato, em porcentagem da janela.
 *
 * Porcentagem, e não pixels: quem arrasta numa tela grande e depois abre num
 * notebook receberia um painel ocupando a tela inteira. Os limites existem
 * pelos dois lados — abaixo de 24% o conteúdo do artefato não cabe, acima de
 * 72% sobra tira de chat.
 */
export const ARTIFACT_WIDTH_MIN = 24;
export const ARTIFACT_WIDTH_MAX = 72;
export const ARTIFACT_WIDTH_DEFAULT = 42;

export function clampArtifactWidth(value: number): number {
  if (!Number.isFinite(value)) return ARTIFACT_WIDTH_DEFAULT;
  return Math.min(ARTIFACT_WIDTH_MAX, Math.max(ARTIFACT_WIDTH_MIN, Math.round(value * 10) / 10));
}

/**
 * Busca na web ligada?
 *
 * Nasce **desligada**. O plugin da OpenRouter busca em toda requisição, sem
 * o modelo decidir, então deixá-lo ligado por padrão consulta a web até para
 * "resuma este texto" — e cobra a busca em cada uma.
 */
function initialWebSearch(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(WEB_SEARCH_STORAGE_KEY) === 'true';
}

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

function initialArtifactWidth(): number {
  if (typeof window === 'undefined') return ARTIFACT_WIDTH_DEFAULT;
  const stored = Number(window.localStorage.getItem(ARTIFACT_WIDTH_STORAGE_KEY));
  return stored ? clampArtifactWidth(stored) : ARTIFACT_WIDTH_DEFAULT;
}

/**
 * Nível com que novas conversas nascem. `auto` é o padrão porque é o único
 * que não envia parâmetro nenhum ao provedor: quem nunca abriu esta
 * configuração continua com o comportamento anterior à funcionalidade.
 */
function initialDefaultEffort(): EffortLevel {
  if (typeof window === 'undefined') return 'auto';
  const stored = window.localStorage.getItem(EFFORT_STORAGE_KEY);
  return isEffortLevel(stored) ? stored : 'auto';
}

interface SettingsState {
  theme: ThemeMode;
  density: DensityMode;
  reduceMotion: boolean;
  defaultEffort: EffortLevel;
  webSearch: boolean;
  artifactWidth: number;
  setTheme: (theme: ThemeMode) => void;
  setDensity: (density: DensityMode) => void;
  setReduceMotion: (reduceMotion: boolean) => void;
  setDefaultEffort: (effort: EffortLevel) => void;
  setWebSearch: (on: boolean) => void;
  setArtifactWidth: (percent: number) => void;
  toggleTheme: () => void;
  resetPreferences: () => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  theme: initialTheme(),
  density: initialDensity(),
  reduceMotion: initialReduceMotion(),
  defaultEffort: initialDefaultEffort(),
  webSearch: initialWebSearch(),
  artifactWidth: initialArtifactWidth(),
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
  setDefaultEffort: (defaultEffort) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(EFFORT_STORAGE_KEY, defaultEffort);
    set({ defaultEffort });
  },
  setWebSearch: (webSearch) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(WEB_SEARCH_STORAGE_KEY, String(webSearch));
    set({ webSearch });
  },
  toggleTheme: () => {
    const theme = get().theme === 'dark' ? 'light' : 'dark';
    if (typeof window !== 'undefined') window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    set({ theme });
  },
  setArtifactWidth: (percent) => {
    const largura = clampArtifactWidth(percent);
    if (typeof window !== 'undefined') window.localStorage.setItem(ARTIFACT_WIDTH_STORAGE_KEY, String(largura));
    set({ artifactWidth: largura });
  },
  resetPreferences: () => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
      window.localStorage.removeItem(DENSITY_STORAGE_KEY);
      window.localStorage.removeItem(MOTION_STORAGE_KEY);
      window.localStorage.removeItem(EFFORT_STORAGE_KEY);
      window.localStorage.removeItem(ARTIFACT_WIDTH_STORAGE_KEY);
      window.localStorage.removeItem(WEB_SEARCH_STORAGE_KEY);
    }
    set({ theme: 'light', density: 'comfortable', reduceMotion: false, defaultEffort: 'auto', webSearch: false, artifactWidth: ARTIFACT_WIDTH_DEFAULT });
  },
}));
