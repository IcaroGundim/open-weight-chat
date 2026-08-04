import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Pencil, Plus, ShieldAlert, Trash2, X } from 'lucide-react';
import { deleteProviderSettings, getProviderSettings, saveProviderSettings } from '../api';
import { useChatStore } from '../store/chat';
import type { ProviderSettings, SecretStorageStatus } from '../types';

interface ModelDraft {
  id: string;
  label: string;
  ctx: string;
  reasoning: boolean;
  inputPrice: string;
  outputPrice: string;
}

interface Draft {
  id: string;
  label: string;
  baseURL: string;
  apiKey: string;
  models: ModelDraft[];
}

const emptyModel = (): ModelDraft => ({ id: '', label: '', ctx: '', reasoning: false, inputPrice: '', outputPrice: '' });

const emptyDraft = (): Draft => ({ id: '', label: '', baseURL: '', apiKey: '', models: [emptyModel()] });

function draftFrom(provider: ProviderSettings): Draft {
  return {
    id: provider.id,
    label: provider.label,
    baseURL: provider.baseURL,
    apiKey: '',
    models: provider.models.length > 0
      ? provider.models.map((model) => ({
          id: model.id,
          label: model.label ?? '',
          ctx: String(model.ctx),
          reasoning: model.reasoning ?? false,
          inputPrice: model.pricing?.inputPerMillion != null ? String(model.pricing.inputPerMillion) : '',
          outputPrice: model.pricing?.outputPerMillion != null ? String(model.pricing.outputPerMillion) : '',
        }))
      : [emptyModel()],
  };
}

function optionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

export function ProviderSettingsTab() {
  const [providers, setProviders] = useState<ProviderSettings[]>([]);
  const [secretStorage, setSecretStorage] = useState<SecretStorageStatus>({ available: true, reason: null });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmingKeyId, setConfirmingKeyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const loadModels = useChatStore((state) => state.loadModels);

  const refresh = useCallback(async () => {
    try {
      const result = await getProviderSettings();
      setProviders(result.providers);
      setSecretStorage(result.secretStorage);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível carregar os provedores.');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startCreate = () => {
    setError(null);
    setEditingId(null);
    setDraft(emptyDraft());
  };

  const startEdit = (provider: ProviderSettings) => {
    setError(null);
    setConfirmingId(null);
    setEditingId(provider.id);
    setDraft(draftFrom(provider));
  };

  const updateModel = (index: number, patch: Partial<ModelDraft>) => {
    setDraft((current) => current && {
      ...current,
      models: current.models.map((model, position) => (position === index ? { ...model, ...patch } : model)),
    });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const models = draft.models
        .filter((model) => model.id.trim())
        .map((model) => ({
          id: model.id.trim(),
          label: model.label.trim() || undefined,
          ctx: Number(model.ctx.trim()),
          reasoning: model.reasoning,
          pricing: {
            inputPerMillion: optionalNumber(model.inputPrice),
            outputPerMillion: optionalNumber(model.outputPrice),
          },
        }));
      await saveProviderSettings(draft.id.trim(), {
        label: draft.label.trim(),
        baseURL: draft.baseURL.trim(),
        models,
        // Campo vazio ao editar mantém a chave já gravada.
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      });
      setDraft(null);
      setEditingId(null);
      await refresh();
      await loadModels();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível salvar o provedor.');
    } finally {
      setSaving(false);
    }
  };

  // Apagar a chave é destrutivo e irreversível — exige o mesmo dois-passos da
  // exclusão do provedor, em vez de disparar no primeiro clique.
  const removeKey = async (provider: ProviderSettings) => {
    setError(null);
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
      setError(reason instanceof Error ? reason.message : 'Não foi possível remover a chave.');
    }
  };

  const remove = async (id: string) => {
    setError(null);
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
      setError(reason instanceof Error ? reason.message : 'Não foi possível excluir o provedor.');
    }
  };

  return (
    <div id="settings-panel-providers" role="tabpanel" aria-labelledby="settings-tab-providers">
      <div className="settings-section-intro">
        <h3>Conecte qualquer provedor compatível com a API da OpenAI.</h3>
        <p>
          A chave sobe uma vez, é cifrada e guardada no servidor. Ela nunca volta para o navegador —
          esta tela só mostra se existe.
        </p>
      </div>

      {!secretStorage.available ? (
        <div className="provider-warning" role="status">
          <ShieldAlert size={17} aria-hidden="true" />
          <span>{secretStorage.reason}</span>
        </div>
      ) : null}

      {error ? <p className="provider-error" role="alert">{error}</p> : null}

      <div className="settings-group">
        <div className="settings-group-heading">
          <strong>Provedores cadastrados</strong>
          <span>Somam-se aos embutidos, sem substituí-los.</span>
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
                <span className="provider-row-count">{provider.models.length} modelo{provider.models.length === 1 ? '' : 's'}</span>
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
            <span>O identificador não pode repetir um provedor embutido.</span>
          </div>

          <div className="provider-grid">
            <label className="provider-field">
              <span>Identificador</span>
              <input
                value={draft.id}
                onChange={(event) => setDraft({ ...draft, id: event.target.value })}
                readOnly={Boolean(editingId)}
                placeholder="opencode"
                required
              />
            </label>
            <label className="provider-field">
              <span>Nome</span>
              <input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder="OpenCode Zen" required />
            </label>
          </div>

          <label className="provider-field">
            <span>URL base</span>
            <input value={draft.baseURL} onChange={(event) => setDraft({ ...draft, baseURL: event.target.value })} placeholder="https://opencode.ai/zen/v1" required />
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
            <strong>Modelos</strong>
            <span>A janela de contexto é obrigatória: é ela que dirige o corte de histórico.</span>
          </div>

          {draft.models.map((model, index) => (
            <div className="provider-model-row" key={index}>
              <label className="provider-field">
                <span>Id do modelo</span>
                <input value={model.id} onChange={(event) => updateModel(index, { id: event.target.value })} placeholder="gpt-5.6-luna" />
              </label>
              <label className="provider-field">
                <span>Contexto</span>
                <input inputMode="numeric" value={model.ctx} onChange={(event) => updateModel(index, { ctx: event.target.value })} placeholder="272000" />
              </label>
              <label className="provider-field">
                <span>US$ / 1M entrada</span>
                <input inputMode="decimal" value={model.inputPrice} onChange={(event) => updateModel(index, { inputPrice: event.target.value })} placeholder="opcional" />
              </label>
              <label className="provider-field">
                <span>US$ / 1M saída</span>
                <input inputMode="decimal" value={model.outputPrice} onChange={(event) => updateModel(index, { outputPrice: event.target.value })} placeholder="opcional" />
              </label>
              <label className="provider-check">
                <input type="checkbox" checked={model.reasoning} onChange={(event) => updateModel(index, { reasoning: event.target.checked })} />
                <span>Raciocínio</span>
              </label>
              {draft.models.length > 1 ? (
                <button
                  type="button"
                  className="btn btn-icon"
                  onClick={() => setDraft({ ...draft, models: draft.models.filter((_, position) => position !== index) })}
                  aria-label="Remover este modelo"
                >
                  <X size={15} />
                </button>
              ) : null}
            </div>
          ))}

          <div className="provider-form-actions">
            <button type="button" className="btn" onClick={() => setDraft({ ...draft, models: [...draft.models, emptyModel()] })}>
              <Plus size={15} aria-hidden="true" /> Adicionar modelo
            </button>
            <span className="provider-form-spacer" />
            <button type="button" className="btn" onClick={() => { setDraft(null); setEditingId(null); }}>Cancelar</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Salvando…' : 'Salvar'}</button>
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
