type ShikiHighlighter = {
  codeToHtml: (code: string, options: { lang: string; theme: string }) => string;
};

type LanguageModule = { default: unknown };
type ThemeModule = { default: unknown };

const aliases: Record<string, string> = {
  js: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  yml: 'yaml',
  md: 'markdown',
  rs: 'rust',
};

const supportedLanguages = [
  'javascript', 'jsx', 'typescript', 'tsx', 'python', 'json', 'bash',
  'sql', 'html', 'css', 'go', 'rust', 'markdown',
] as const;

const languageLoaders: Record<string, () => Promise<LanguageModule>> = {
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  python: () => import('@shikijs/langs/python'),
  json: () => import('@shikijs/langs/json'),
  bash: () => import('@shikijs/langs/bash'),
  sql: () => import('@shikijs/langs/sql'),
  html: () => import('@shikijs/langs/html'),
  css: () => import('@shikijs/langs/css'),
  go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'),
  markdown: () => import('@shikijs/langs/markdown'),
};

let highlighterPromise: Promise<ShikiHighlighter | null> | undefined;

async function loadHighlighter(): Promise<ShikiHighlighter | null> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      try {
        const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, themeModule, ...languageModules] = await Promise.all([
          import('shiki/core'),
          import('shiki/engine/javascript'),
          import('@shikijs/themes/github-dark'),
          ...supportedLanguages.map((language) => languageLoaders[language]()),
        ]);
        const langs = languageModules.flatMap((module) => Array.isArray(module.default) ? module.default : [module.default]);
        const themes = [themeModule.default];
        return await createHighlighterCore({
          engine: createJavaScriptRegexEngine(),
          themes,
          langs,
          warnings: false,
        }) as ShikiHighlighter;
      } catch {
        return null;
      }
    })();
  }
  return highlighterPromise;
}

export function normalizeCodeLanguage(language?: string): string | null {
  const normalized = language?.trim().toLowerCase().replace(/^language-/, '');
  if (!normalized) return null;
  const languageName = aliases[normalized] ?? normalized;
  return (supportedLanguages as readonly string[]).includes(languageName) ? languageName : null;
}

export async function highlightCode(code: string, language?: string): Promise<string | null> {
  const normalizedLanguage = normalizeCodeLanguage(language);
  if (!normalizedLanguage) return null;
  const highlighter = await loadHighlighter();
  if (!highlighter) return null;
  try {
    return highlighter.codeToHtml(code, { lang: normalizedLanguage, theme: 'github-dark' });
  } catch {
    return null;
  }
}
