import { useCallback, useEffect, useState } from 'react';
import { Globe, ShieldAlert } from 'lucide-react';
import { deleteSearchSettings, getSearchSettings, putSearchSettings, testSearchSettings } from '../api';
import type { SearchBackend, SearchResult, SearchSettings, SecretStorageStatus } from '../types';

/**
 * Configuração da busca na web.
 *
 * Reusa as classes do painel de provedores de propósito: é a mesma natureza de
 * tela — um serviço externo, uma chave que sobe uma vez e não volta — e
 * inventar uma linguagem visual só para ela faria a mesma coisa parecer duas.
 */

const BACKENDS: Array<{
  id: SearchBackend;
  label: string;
  hint: string;
  exigeChave: boolean;
  exigeUrl: boolean;
  /** Roda dentro do pedido de chat, e só com modelos daquele provedor. */
  nativa?: boolean;
}> = [
  {
    id: 'openrouter',
    label: 'OpenRouter (nativa)',
    hint: 'A própria OpenRouter busca e cita, na mesma requisição. Não pede chave de buscador — usa a que você já configurou.',
    exigeChave: false,
    exigeUrl: false,
    nativa: true,
  },
  {
    id: 'brave',
    label: 'Brave Search',
    hint: 'Índice próprio, com plano gratuito. A chave sai do painel da Brave Search API.',
    exigeChave: true,
    exigeUrl: false,
  },
  {
    id: 'tavily',
    label: 'Tavily',
    hint: 'Feito para consumo por modelos: devolve trechos já resumidos.',
    exigeChave: true,
    exigeUrl: false,
  },
  {
    id: 'searxng',
    label: 'SearXNG',
    hint: 'Sua própria instância. Nada sai para um serviço de terceiros além dos buscadores que ela consultar.',
    exigeChave: false,
    exigeUrl: true,
  },
];

function backendDe(id: SearchBackend) {
  return BACKENDS.find((backend) => backend.id === id) ?? BACKENDS[0];
}

function mensagemDe(motivo: unknown, padrao: string): string {
  return motivo instanceof Error ? motivo.message : padrao;
}

export function SearchSettingsTab() {
  const [settings, setSettings] = useState<SearchSettings | null>(null);
  const [secretStorage, setSecretStorage] = useState<SecretStorageStatus>({ available: true, reason: null });
  const [backend, setBackend] = useState<SearchBackend>('brave');
  const [baseURL, setBaseURL] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [maxResults, setMaxResults] = useState(5);
  const [erro, setErro] = useState<string | null>(null);
  const [sucesso, setSucesso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [testando, setTestando] = useState(false);
  const [amostra, setAmostra] = useState<SearchResult[] | null>(null);

  const recarregar = useCallback(async () => {
    try {
      const resultado = await getSearchSettings();
      setSecretStorage(resultado.secretStorage);
      setSettings(resultado.settings);
      if (resultado.settings) {
        setBackend(resultado.settings.backend);
        setBaseURL(resultado.settings.baseURL ?? '');
        setMaxResults(resultado.settings.maxResults);
      }
    } catch (motivo) {
      setErro(mensagemDe(motivo, 'Não foi possível carregar a configuração de busca.'));
    }
  }, []);

  useEffect(() => { void recarregar(); }, [recarregar]);

  const escolhido = backendDe(backend);
  // A chave já guardada continua valendo: só é obrigatória quando ainda não
  // existe nenhuma para este usuário.
  const faltaChave = escolhido.exigeChave && !apiKey.trim() && !settings?.hasKey;
  const faltaUrl = escolhido.exigeUrl && !baseURL.trim();

  const salvar = async (enabled: boolean) => {
    setErro(null);
    setSucesso(null);
    setSalvando(true);
    try {
      const salvo = await putSearchSettings({
        backend,
        baseURL: escolhido.exigeUrl ? baseURL.trim() : undefined,
        // Campo vazio mantém a chave guardada — não apaga.
        apiKey: apiKey.trim() ? apiKey.trim() : undefined,
        maxResults,
        enabled,
      });
      setSettings(salvo);
      setApiKey('');
      setSucesso(enabled ? 'Busca configurada. Os modelos já podem consultar a web.' : 'Busca desligada.');
    } catch (motivo) {
      setErro(mensagemDe(motivo, 'Não foi possível salvar a configuração de busca.'));
    } finally {
      setSalvando(false);
    }
  };

  const testar = async () => {
    setErro(null);
    setSucesso(null);
    setAmostra(null);
    setTestando(true);
    try {
      const resultados = await testSearchSettings();
      setAmostra(resultados);
      setSucesso(resultados.length > 0
        ? 'A busca respondeu.'
        : 'A busca respondeu, mas sem resultados para a consulta de teste.');
    } catch (motivo) {
      setErro(mensagemDe(motivo, 'A busca de teste falhou.'));
    } finally {
      setTestando(false);
    }
  };

  const remover = async () => {
    setErro(null);
    setSucesso(null);
    try {
      await deleteSearchSettings();
      setSettings(null);
      setApiKey('');
      setBaseURL('');
      setSucesso('Configuração de busca apagada.');
    } catch (motivo) {
      setErro(mensagemDe(motivo, 'Não foi possível apagar a configuração.'));
    }
  };

  return (
    <div id="settings-panel-search" role="tabpanel" aria-labelledby="settings-tab-search">
      <div className="settings-section-intro">
        <h3>Deixe os modelos consultarem a web.</h3>
        <p>
          Com a busca ligada, o modelo pode pedir uma consulta durante a resposta; o servidor busca, devolve os
          trechos para ele e as fontes aparecem na mensagem. São no máximo três buscas por resposta, e cada uma
          custa uma chamada a mais ao seu provedor de modelo.
        </p>
      </div>

      {!secretStorage.available ? (
        <div className="provider-warning" role="status">
          <ShieldAlert size={17} aria-hidden="true" />
          <span>{secretStorage.reason}</span>
        </div>
      ) : null}

      {erro ? <p className="provider-error" role="alert">{erro}</p> : null}
      {sucesso ? <p className="provider-success" role="status">{sucesso}</p> : null}

      <div className="settings-group">
        <div className="settings-group-heading">
          <strong>Buscador</strong>
          <span>A chave sobe uma vez, é cifrada e nunca volta ao navegador.</span>
        </div>

        <div className="search-backend-grid">
          {BACKENDS.map((opcao) => (
            <button
              type="button"
              key={opcao.id}
              className={'search-backend' + (backend === opcao.id ? ' search-backend-active' : '')}
              onClick={() => setBackend(opcao.id)}
              aria-pressed={backend === opcao.id}
            >
              <strong>{opcao.label}</strong>
              <span>{opcao.hint}</span>
            </button>
          ))}
        </div>

        {escolhido.nativa ? (
          <p className="search-nota-nativa">
            Vale <strong>só para modelos da OpenRouter</strong>. Com um modelo de outro provedor selecionado, a busca
            simplesmente não acontece — e o modelo não fica sabendo que ela existe, para não pedir algo que não chega.
            O custo entra junto do custo da mensagem, que passa a vir da própria OpenRouter.
          </p>
        ) : null}

        {escolhido.exigeUrl ? (
          <label className="provider-field">
            <span>URL da instância</span>
            <input
              type="url"
              value={baseURL}
              onChange={(evento) => setBaseURL(evento.target.value)}
              placeholder="https://busca.seudominio.com"
            />
            <small className="provider-field-hint">
              O formato <code>json</code> precisa estar habilitado em <code>search.formats</code> no settings.yml da
              instância — sem isso ela responde 403.
            </small>
          </label>
        ) : null}

        {escolhido.nativa ? null : (
        <label className="provider-field">
          <span>Chave da API{escolhido.exigeChave ? '' : ' (opcional)'}</span>
          <input
            type="password"
            value={apiKey}
            onChange={(evento) => setApiKey(evento.target.value)}
            placeholder={settings?.hasKey ? 'Uma chave já está guardada — preencha só para trocar' : 'Cole a chave aqui'}
            disabled={!secretStorage.available}
            autoComplete="off"
          />
          {!escolhido.exigeChave ? (
            <small className="provider-field-hint">Só é preciso se a sua instância estiver atrás de um proxy autenticado.</small>
          ) : null}
        </label>
        )}

        <label className="provider-field">
          <span>Resultados por busca</span>
          <input
            type="number"
            min={1}
            max={10}
            value={maxResults}
            onChange={(evento) => setMaxResults(Math.min(10, Math.max(1, Number(evento.target.value) || 5)))}
          />
          <small className="provider-field-hint">
            Mais resultados dão mais contexto ao modelo e aumentam o custo de cada resposta, porque todos entram
            no prompt.
          </small>
        </label>

        <div className="search-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void salvar(true)}
            disabled={salvando || faltaChave || faltaUrl}
          >
            {settings ? 'Salvar' : 'Ligar a busca'}
          </button>
          {settings?.enabled ? (
            <button type="button" className="btn" onClick={() => void salvar(false)} disabled={salvando}>
              Desligar
            </button>
          ) : null}
          <button type="button" className="btn" onClick={() => void testar()} disabled={testando || !settings}>
            {testando ? 'Testando…' : 'Testar'}
          </button>
          {settings ? (
            <button type="button" className="btn btn-danger" onClick={() => void remover()}>Apagar</button>
          ) : null}
        </div>

        {faltaChave ? <p className="provider-field-hint">Este buscador exige uma chave.</p> : null}
        {faltaUrl ? <p className="provider-field-hint">Informe a URL da sua instância.</p> : null}

        {settings ? (
          <p className="search-status">
            <Globe size={14} aria-hidden="true" />
            {settings.enabled
              ? `Ligada em ${backendDe(settings.backend).label}, ${settings.maxResults} resultados por busca.`
              : `Desligada. A configuração de ${backendDe(settings.backend).label} continua guardada.`}
          </p>
        ) : null}

        {amostra && amostra.length > 0 ? (
          <ol className="search-sample">
            {amostra.slice(0, 3).map((resultado) => (
              <li key={resultado.url}>
                <a href={resultado.url} target="_blank" rel="noreferrer noopener">{resultado.title}</a>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </div>
  );
}
