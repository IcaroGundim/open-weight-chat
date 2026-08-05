import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Pencil, Plus, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import { deleteProviderSettings, discoverProviderModels, getProviderSettings, saveProviderSettings } from '../api';
import { useChatStore } from '../store/chat';
import { AgentOrb } from './AgentOrb';
import type { ProviderSettings, SecretStorageStatus } from '../types';

interface Draft {
  id: string;
  label: string;
  baseURL: string;
  apiKey: string;
}

const emptyDraft = (): Draft => ({ id: '', label: '', baseURL: '', apiKey: '' });

function draftFrom(provider: ProviderSettings): Draft {
  return {
    id: provider.id,
    label: provider.label,
    baseURL: provider.baseURL,
    apiKey: '',
  };
}

function contextLabel(value: number): string {
  return `${new Intl.NumberFormat('pt-BR').format(value)} tokens`;
}

function normalizeProviderId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^-+/u, '')
    .slice(0, 32);
}

function reasonMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

export function ProviderSettingsTab() {
  const [providers, setProviders] = useState<ProviderSettings[]>([]);
  const [secretStorage, setSecretStorage] = useState<SecretStorageStatus>({ available: true, reason: null });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmingKeyId, setConfirmingKeyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [discoveringId, setDiscoveringId] = useState<string | null>(null);
  const loadModels = useChatStore((state) => state.loadModels);

  const refresh = useCallback(async () => {
    try {
      const result = await getProviderSettings();
      setProviders(result.providers);
      setSecretStorage(result.secretStorage);
      return result.providers;
    } catch (reason) {
      setError(reasonMessage(reason, 'Não foi possível carregar os provedores.'));
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startCreate = () => {
    setError(null);
    setSuccess(null);
    setEditingId(null);
    setDraft(emptyDraft());
  };

  const startEdit = (provider: ProviderSettings) => {
    setError(null);
    setSuccess(null);
    setConfirmingId(null);
    setConfirmingKeyId(null);
    setEditingId(provider.id);
    setDraft(draftFrom(provider));
  };

  const retryDiscovery = async (id: string) => {
    setError(null);
    setSuccess(null);
    setDiscoveringId(id);
    try {
      await discoverProviderModels(id);
      const refreshed = await refresh();
      await loadModels();
      const provider = refreshed?.find((item) => item.id === id);
      if (provider) setSuccess(`${provider.models.length} modelo${provider.models.length === 1 ? '' : 's'} carregado${provider.models.length === 1 ? '' : 's'} de ${provider.label}.`);
    } catch (reason) {
      setError(reasonMessage(reason, 'Não foi possível atualizar os modelos do provedor.'));
    } finally {
      setDiscoveringId(null);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft) return;

    const id = editingId ? draft.id.trim() : normalizeProviderId(draft.id);
    const label = draft.label.trim();
    const baseURL = draft.baseURL.trim();
    if (!id || !label || !baseURL) {
      setError('Preencha o identificador, o nome e a URL base do provedor.');
      return;
    }
    if (!editingId && id !== draft.id) setDraft({ ...draft, id });

    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const existing = providers.find((provider) => provider.id === id);
      const hasNewKey = Boolean(draft.apiKey.trim());
      const endpointChanged = !existing || existing.baseURL !== baseURL || hasNewKey;
      const saved = await saveProviderSettings(id, {
        label,
        baseURL,
        // A lista deixa de ser uma entrada manual. Ao alterar a conexão,
        // descartamos o catálogo antigo para não misturar modelos de URLs.
        models: endpointChanged ? [] : (existing?.models ?? []),
        ...(hasNewKey ? { apiKey: draft.apiKey.trim() } : {}),
      });

      const shouldDiscover = endpointChanged || saved.models.length === 0;
      if (shouldDiscover) {
        try {
          await discoverProviderModels(saved.id);
        } catch (reason) {
          // O cadastro continua salvo para permitir corrigir a URL/chave e
          // tentar novamente sem perder o segredo recém-gravado.
          await refresh();
          await loadModels();
          setError(`Provedor salvo, mas não consegui carregar os modelos: ${reasonMessage(reason, 'verifique a conexão e tente novamente.')}`);
          return;
        }
      }

      const refreshed = await refresh();
      await loadModels();
      const updated = refreshed?.find((provider) => provider.id === saved.id);
      if (updated) {
        // Mantemos o cadastro visível: assim o resultado da descoberta não
        // desaparece quando o formulário encurta dentro do painel rolável.
        setDraft(draftFrom(updated));
        setEditingId(updated.id);
        setSuccess(`${updated.models.length} modelo${updated.models.length === 1 ? '' : 's'} encontrado${updated.models.length === 1 ? '' : 's'} e pronto${updated.models.length === 1 ? '' : 's'} para usar no chat.`);
      }
    } catch (reason) {
      setError(reasonMessage(reason, 'Não foi possível salvar o provedor.'));
    } finally {
      setSaving(false);
    }
  };

  // Apagar a chave é destrutivo e irreversível — exige confirmação explícita.
  const removeKey = async (provider: ProviderSettings) => {
    setError(null);
    setSuccess(null);
    setConfirmingKeyId(null);
    try {
      await saveProviderSettings(provider.id, {
        label: provider.label,
        baseURL: provider.baseURL,
        models: provider.models,
        apiKey: null,
      });
      await refresh();
      await loadModels();
    } catch (reason) {
      setError(reasonMessage(reason, 'Não foi possível remover a chave.'));
    }
  };

  const remove = async (id: string) => {
    setError(null);
    setSuccess(null);
    try {
      await deleteProviderSettings(id);
      setConfirmingId(null);
      if (editingId === id) {
        setDraft(null);
        setEditingId(null);
      }
      await refresh();
      await loadModels();
    } catch (reason) {
      setError(reasonMessage(reason, 'Não foi possível excluir o provedor.'));
    }
  };

  const draftProvider = draft ? providers.find((provider) => provider.id === draft.id) : undefined;
  const draftModels = draftProvider?.models ?? [];

  return (
    <div id="settings-panel-providers" role="tabpanel" aria-labelledby="settings-tab-providers">
      <div className="settings-section-intro">
        <h3>Conecte qualquer provedor compatível com a API da OpenAI.</h3>
        <p>
          A chave sobe uma vez, é cifrada e guardada no servidor. O aplicativo cria automaticamente a proteção interna;
          você só precisa colar a chave do provedor. Ao salvar, o servidor consulta o catálogo e traz os modelos para o chat.
        </p>
      </div>

      {!secretStorage.available ? (
        <div className="provider-warning" role="status">
          <ShieldAlert size={17} aria-hidden="true" />
          <span>{secretStorage.reason}</span>
        </div>
      ) : null}

      {error && !draft ? <p className="provider-error" role="alert">{error}</p> : null}
      {success && !draft ? <p className="provider-success" role="status">{success}</p> : null}

      <div className="settings-group">
        <div className="settings-group-heading">
          <strong>Provedores cadastrados</strong>
          <span>Inclui provedores novos e configurações dos embutidos.</span>
        </div>

        {providers.length === 0 ? (
          <p className="provider-empty">Nenhum provedor cadastrado por aqui ainda.</p>
        ) : (
          <div className="provider-list">
            {providers.map((provider) => (
              <div className="provider-row" key={provider.id}>
                <span className="provider-row-copy">
                  <strong>{provider.label}</strong>
                  <small>{provider.baseURL}</small>
                </span>
                <span className={provider.hasKey ? 'provider-key-on' : 'provider-key-off'}>
                  <KeyRound size={13} aria-hidden="true" />
                  {provider.hasKey ? 'chave configurada' : 'sem chave'}
                </span>
                <span className={provider.models.length > 0 ? 'provider-row-count' : 'provider-row-count provider-row-count-warning'}>
                  {provider.models.length > 0 ? `${provider.models.length} modelo${provider.models.length === 1 ? '' : 's'}` : 'modelos não carregados'}
                </span>
                {confirmingId === provider.id ? (
                  <span className="provider-row-actions">
                    <span className="provider-confirm-label">Excluir o provedor?</span>
                    <button type="button" className="btn btn-danger provider-confirm" onClick={() => void remove(provider.id)}>Excluir</button>
                    <button type="button" className="btn provider-confirm" onClick={() => setConfirmingId(null)}>Cancelar</button>
                  </span>
                ) : confirmingKeyId === provider.id ? (
                  <span className="provider-row-actions">
                    <span className="provider-confirm-label">Apagar a chave?</span>
                    <button type="button" className="btn btn-danger provider-confirm" onClick={() => void removeKey(provider)}>Apagar</button>
                    <button type="button" className="btn provider-confirm" onClick={() => setConfirmingKeyId(null)}>Cancelar</button>
                  </span>
                ) : (
                  <span className="provider-row-actions">
                    <button
                      type="button"
                      className="btn btn-icon"
                      onClick={() => void retryDiscovery(provider.id)}
                      disabled={discoveringId === provider.id}
                      aria-label={`Atualizar modelos de ${provider.label}`}
                      title="Atualizar modelos"
                    >
                      <RefreshCw size={15} className={discoveringId === provider.id ? 'provider-spin' : undefined} />
                    </button>
                    {provider.hasKey ? (
                      <button type="button" className="btn btn-icon" onClick={() => { setConfirmingId(null); setConfirmingKeyId(provider.id); }} aria-label={`Apagar a chave de ${provider.label}`} title="Apagar a chave">
                        <KeyRound size={15} />
                      </button>
                    ) : null}
                    <button type="button" className="btn btn-icon" onClick={() => startEdit(provider)} aria-label={`Editar ${provider.label}`} title="Editar">
                      <Pencil size={15} />
                    </button>
                    <button type="button" className="btn btn-icon" onClick={() => { setConfirmingKeyId(null); setConfirmingId(provider.id); }} aria-label={`Excluir ${provider.label}`} title="Excluir">
                      <Trash2 size={15} />
                    </button>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {draft ? (
        <form className="settings-group provider-form" onSubmit={(event) => void submit(event)}>
          <div className="settings-group-heading">
            <strong>{editingId ? `Editar ${editingId}` : 'Novo provedor'}</strong>
            <span>Use minúsculas, números e hífen. Para configurar um provedor embutido, use o identificador dele, como <code>openrouter</code>.</span>
          </div>

          <div className="provider-grid">
            <label className="provider-field">
              <span>Identificador</span>
              <input
                value={draft.id}
                onChange={(event) => setDraft({ ...draft, id: event.target.value })}
                readOnly={Boolean(editingId)}
                placeholder="opencode"
                pattern="[a-zA-Z0-9][a-zA-Z0-9 -]{0,31}"
                required
              />
              <small className="provider-field-hint">O identificador é normalizado para minúsculas ao salvar.</small>
            </label>
            <label className="provider-field">
              <span>Nome</span>
              <input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder="OpenCode Zen" required />
            </label>
          </div>

          <label className="provider-field">
            <span>URL base</span>
            <input value={draft.baseURL} onChange={(event) => setDraft({ ...draft, baseURL: event.target.value })} placeholder="https://opencode.ai/zen/v1" required />
            <small className="provider-field-hint">O sistema acrescenta /models para buscar os modelos e /chat/completions para conversar.</small>
          </label>

          <label className="provider-field">
            <span>Chave de API</span>
            <input
              type="password"
              autoComplete="off"
              value={draft.apiKey}
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
              placeholder={editingId ? 'Deixe vazio para manter a chave atual' : 'Cole a chave do provedor'}
              disabled={!secretStorage.available}
            />
          </label>

          <div className="settings-group-heading provider-models-heading">
            <strong>Modelos disponíveis</strong>
            <span>Preenchidos automaticamente pelo provedor após salvar.</span>
          </div>
          <div className="provider-models-card">
            {draftModels.length > 0 ? (
              <>
                <div className="provider-models-summary">{draftModels.length} modelo{draftModels.length === 1 ? '' : 's'} encontrado{draftModels.length === 1 ? '' : 's'}</div>
                <div className="provider-models-list">
                  {draftModels.slice(0, 12).map((model) => (
                    <div className="provider-model-item" key={model.id}>
                      <span>
                        <strong>{model.label ?? model.id}</strong>
                        <small>{model.id}</small>
                      </span>
                      <em>{contextLabel(model.ctx)}</em>
                    </div>
                  ))}
                </div>
                {draftModels.length > 12 ? <small className="provider-field-hint">Os outros {draftModels.length - 12} modelos também aparecem no seletor do chat.</small> : null}
              </>
            ) : (
              <p className="provider-models-empty">Nenhum modelo carregado ainda. Salve o provedor para consultar /models automaticamente.</p>
            )}
          </div>

          {error ? <p className="provider-error provider-form-feedback" role="alert">{error}</p> : null}
          {success ? <p className="provider-success provider-form-feedback" role="status">{success}</p> : null}

          <div className="provider-form-actions">
            <span className="provider-form-note">A descoberta usa a chave somente no servidor.</span>
            <span className="provider-form-spacer" />
            <button type="button" className="btn" onClick={() => { setDraft(null); setEditingId(null); setError(null); setSuccess(null); }}>Concluir</button>
            <button type="submit" className="btn btn-primary provider-submit" disabled={saving}>
              {saving ? <><AgentOrb activity="buscando" /> Salvando e buscando…</> : 'Salvar e buscar modelos'}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="btn btn-primary provider-add" onClick={startCreate}>
          <Plus size={16} aria-hidden="true" /> Adicionar provedor
        </button>
      )}
    </div>
  );
}
