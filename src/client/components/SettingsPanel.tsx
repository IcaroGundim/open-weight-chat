import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Cpu,
  Database,
  Moon,
  Palette,
  RotateCcw,
  SlidersHorizontal,
  Sun,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useSettingsStore } from '../store/settings';
import type { DensityMode, ModelOption, ThemeMode } from '../types';

type SettingsTab = 'appearance' | 'model' | 'data';

type SettingsPanelProps = {
  models: ModelOption[];
  selectedModelId: string | null;
  onModelChange: (id: string) => void;
  onClose: () => void;
};

const tabs: Array<{ id: SettingsTab; label: string; hint: string; icon: LucideIcon }> = [
  { id: 'appearance', label: 'Aparência', hint: 'Tema e leitura', icon: Palette },
  { id: 'model', label: 'Modelo', hint: 'Padrão e acesso', icon: Cpu },
  { id: 'data', label: 'Dados locais', hint: 'Privacidade e reset', icon: Database },
];

const themeOptions: Array<{ id: ThemeMode; label: string; description: string; icon: LucideIcon }> = [
  { id: 'light', label: 'Claro', description: 'Papel claro para trabalhar durante o dia.', icon: Sun },
  { id: 'dark', label: 'Escuro', description: 'Canvas escuro para ambientes com pouca luz.', icon: Moon },
];

const densityOptions: Array<{ id: DensityMode; label: string; description: string }> = [
  { id: 'comfortable', label: 'Confortável', description: 'Mais espaço entre mensagens e controles.' },
  { id: 'compact', label: 'Compacta', description: 'Mais conteúdo visível na mesma área.' },
];

export function SettingsPanel({ models, selectedModelId, onModelChange, onClose }: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance');
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const theme = useSettingsStore((state) => state.theme);
  const density = useSettingsStore((state) => state.density);
  const reduceMotion = useSettingsStore((state) => state.reduceMotion);
  const setTheme = useSettingsStore((state) => state.setTheme);
  const setDensity = useSettingsStore((state) => state.setDensity);
  const setReduceMotion = useSettingsStore((state) => state.setReduceMotion);
  const resetPreferences = useSettingsStore((state) => state.resetPreferences);

  const providers = useMemo(() => {
    const grouped = new Map<string, { label: string; total: number; configured: number }>();
    for (const model of models) {
      const current = grouped.get(model.providerId) ?? { label: model.providerLabel, total: 0, configured: 0 };
      current.total += 1;
      if (model.configured !== false) current.configured += 1;
      grouped.set(model.providerId, current);
    }
    return Array.from(grouped, ([id, value]) => ({ id, ...value }));
  }, [models]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="settings-backdrop" role="presentation" onClick={onClose}>
      <section
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div>
            <span className="settings-kicker">WORKSPACE</span>
            <h2 id="settings-title">Configurações</h2>
            <p>Preferências do ambiente local e do próximo pedido.</p>
          </div>
          <button ref={closeButtonRef} type="button" className="btn btn-icon" onClick={onClose} aria-label="Fechar configurações">
            <X size={17} />
          </button>
        </header>

        <div className="settings-body">
          <nav className="settings-tabs" aria-label="Abas de configurações" role="tablist" aria-orientation="vertical">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  type="button"
                  role="tab"
                  className={'settings-tab' + (active ? ' settings-tab-active' : '')}
                  key={tab.id}
                  id={'settings-tab-' + tab.id}
                  aria-selected={active}
                  aria-controls={'settings-panel-' + tab.id}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>
                    <strong>{tab.label}</strong>
                    <small>{tab.hint}</small>
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="settings-content">
            {activeTab === 'appearance' ? (
              <div id="settings-panel-appearance" role="tabpanel" aria-labelledby="settings-tab-appearance">
                <div className="settings-section-intro">
                  <span className="settings-kicker">APARÊNCIA</span>
                  <h3>Um espaço de trabalho que acompanha seu ritmo.</h3>
                  <p>As escolhas são aplicadas imediatamente e ficam salvas neste navegador.</p>
                </div>

                <div className="settings-group">
                  <div className="settings-group-heading">
                    <strong>Tema</strong>
                    <span>Escolha a leitura principal do canvas.</span>
                  </div>
                  <div className="settings-theme-grid">
                    {themeOptions.map((option) => {
                      const Icon = option.icon;
                      const active = theme === option.id;
                      return (
                        <button
                          type="button"
                          className={'settings-theme-option' + (active ? ' settings-theme-option-active' : '')}
                          key={option.id}
                          aria-pressed={active}
                          onClick={() => setTheme(option.id)}
                        >
                          <span className={'settings-theme-preview settings-theme-preview-' + option.id} aria-hidden="true">
                            <i /><i /><i />
                          </span>
                          <span className="settings-theme-copy">
                            <strong><Icon size={14} aria-hidden="true" /> {option.label}</strong>
                            <small>{option.description}</small>
                          </span>
                          {active ? <Check className="settings-check" size={16} aria-hidden="true" /> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="settings-group">
                  <div className="settings-group-heading">
                    <strong>Densidade</strong>
                    <span>Controle quanto conteúdo cabe na conversa.</span>
                  </div>
                  <div className="settings-choice-list">
                    {densityOptions.map((option) => (
                      <label className={'settings-choice-row' + (density === option.id ? ' settings-choice-row-active' : '')} key={option.id}>
                        <input
                          type="radio"
                          name="density"
                          value={option.id}
                          checked={density === option.id}
                          onChange={() => setDensity(option.id)}
                        />
                        <span>
                          <strong>{option.label}</strong>
                          <small>{option.description}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                <label className="settings-toggle-row">
                  <span>
                    <strong>Reduzir movimento</strong>
                    <small>Desativa transições e animações decorativas.</small>
                  </span>
                  <input
                    className="settings-toggle-input"
                    type="checkbox"
                    checked={reduceMotion}
                    onChange={(event) => setReduceMotion(event.target.checked)}
                  />
                  <span className="settings-switch" aria-hidden="true" />
                </label>
              </div>
            ) : null}

            {activeTab === 'model' ? (
              <div id="settings-panel-model" role="tabpanel" aria-labelledby="settings-tab-model">
                <div className="settings-section-intro">
                  <span className="settings-kicker">MODELO</span>
                  <h3>Defina com qual modelo as novas conversas começam.</h3>
                  <p>A troca é instantânea e também atualiza o seletor no cabeçalho.</p>
                </div>

                <div className="settings-group">
                  <label className="settings-field">
                    <span>
                      <strong>Modelo padrão</strong>
                      <small>Modelos sem chave configurada ficam indisponíveis para envio.</small>
                    </span>
                    <select
                      value={selectedModelId ?? ''}
                      onChange={(event) => onModelChange(event.target.value)}
                      disabled={models.length === 0}
                    >
                      {models.length === 0 ? <option value="">Nenhum modelo disponível</option> : null}
                      {providers.map((provider) => (
                        <optgroup key={provider.id} label={provider.label}>
                          {models.filter((model) => model.providerId === provider.id).map((model) => (
                            <option key={model.providerId + ':' + model.id} value={model.id} disabled={model.configured === false}>
                              {model.label}{model.reasoning ? ' · raciocínio' : ''}{model.configured === false ? ' · configure a chave' : ''}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="settings-group">
                  <div className="settings-group-heading">
                    <strong>Provedores disponíveis</strong>
                    <span>Catálogo carregado da configuração do servidor.</span>
                  </div>
                  {providers.length === 0 ? (
                    <div className="settings-empty"><SlidersHorizontal size={17} aria-hidden="true" /><span>Nenhum modelo foi carregado ainda.</span></div>
                  ) : (
                    <div className="settings-provider-list">
                      {providers.map((provider) => (
                        <div className="settings-provider-row" key={provider.id}>
                          <span>
                            <strong>{provider.label}</strong>
                            <small>{provider.id}</small>
                          </span>
                          <em className={provider.configured === provider.total ? 'settings-status-ok' : 'settings-status-warn'}>
                            {provider.configured}/{provider.total} ativos
                          </em>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            {activeTab === 'data' ? (
              <div id="settings-panel-data" role="tabpanel" aria-labelledby="settings-tab-data">
                <div className="settings-section-intro">
                  <span className="settings-kicker">DADOS LOCAIS</span>
                  <h3>O que fica no seu ambiente.</h3>
                  <p>Esta instalação mantém o histórico no SQLite do servidor e as preferências no navegador.</p>
                </div>

                <div className="settings-info-list">
                  <div className="settings-info-card">
                    <Database size={18} aria-hidden="true" />
                    <span>
                      <strong>Conversas</strong>
                      <small>Persistidas localmente no SQLite. A busca e a exportação são feitas pelo próprio app.</small>
                    </span>
                    <em>SQLite</em>
                  </div>
                  <div className="settings-info-card">
                    <SlidersHorizontal size={18} aria-hidden="true" />
                    <span>
                      <strong>Preferências</strong>
                      <small>Tema, densidade e movimento reduzido ficam apenas no armazenamento deste navegador.</small>
                    </span>
                    <em>Local</em>
                  </div>
                </div>

                <div className="settings-note">
                  <strong>Segurança</strong>
                  <p>As chaves de API não são exibidas nem salvas nesta interface. Elas continuam no processo do servidor.</p>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <footer className="settings-footer">
          <span className="settings-escape-hint"><kbd>Esc</kbd> para fechar</span>
          <button type="button" className="btn" onClick={resetPreferences}>
            <RotateCcw size={15} aria-hidden="true" /> Restaurar preferências
          </button>
        </footer>
      </section>
    </div>
  );
}
