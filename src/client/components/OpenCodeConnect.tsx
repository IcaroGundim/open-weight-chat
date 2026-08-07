import { useState } from 'react';
import { ExternalLink, KeyRound, Check } from 'lucide-react';
import { OPENCODE_CONSOLE_URL, OPENCODE_PRESETS, type OpenCodePreset } from '../../shared/opencode';

interface OpenCodeConnectProps {
  /** Ids já cadastrados pelo usuário, para o cartão mostrar que está ligado. */
  readonly connectedIds: readonly string[];
  readonly disabled: boolean;
  /** Grava e valida: o mesmo caminho do cadastro manual, sem o formulário. */
  readonly onConnect: (preset: OpenCodePreset, apiKey: string) => Promise<void>;
}

/**
 * Conexão com o OpenCode em dois passos.
 *
 * Isto é o mais perto de "entrar com a conta do OpenCode" que dá para fazer
 * hoje: eles não publicam OAuth para aplicações de terceiros, então não há
 * token para trocar — o acesso ao Zen e ao Go é por chave de API. O que este
 * componente faz é tirar o atrito do caminho que existe: abre o console na aba
 * certa e valida a chave no ato de colar, buscando o catálogo real. Sem isso,
 * uma chave errada só apareceria como erro no meio de uma conversa.
 */
export function OpenCodeConnect({ connectedIds, disabled, onConnect }: OpenCodeConnectProps) {
  const [abertoId, setAbertoId] = useState<string | null>(null);
  const [chave, setChave] = useState('');
  const [salvandoId, setSalvandoId] = useState<string | null>(null);

  const abrir = (preset: OpenCodePreset) => {
    setAbertoId(abertoId === preset.id ? null : preset.id);
    setChave('');
  };

  const conectar = async (preset: OpenCodePreset) => {
    if (!chave.trim()) return;
    setSalvandoId(preset.id);
    try {
      await onConnect(preset, chave.trim());
      setAbertoId(null);
      setChave('');
    } finally {
      setSalvandoId(null);
    }
  };

  return (
    <div className="settings-group">
      <div className="settings-group-heading">
        <strong>Conectar ao OpenCode</strong>
        <span>Uma chave só atende aos dois planos. Ela é cifrada e nunca volta ao navegador.</span>
      </div>

      <div className="opencode-cards">
        {OPENCODE_PRESETS.map((preset) => {
          const conectado = connectedIds.includes(preset.id);
          const aberto = abertoId === preset.id;
          return (
            <div className="opencode-card" key={preset.id} data-conectado={conectado || undefined}>
              <div className="opencode-card-head">
                <span className="opencode-card-title">
                  <strong>{preset.label}</strong>
                  <small>{preset.billing}</small>
                </span>
                {conectado ? (
                  <span className="opencode-card-status"><Check size={14} aria-hidden="true" />conectado</span>
                ) : null}
              </div>
              <p className="opencode-card-text">{preset.description}</p>
              <div className="opencode-card-actions">
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => abrir(preset)}
                  disabled={disabled}
                  aria-expanded={aberto}
                >
                  <KeyRound size={15} aria-hidden="true" />
                  {conectado ? 'Trocar a chave' : 'Conectar'}
                </button>
                {/* noreferrer junto de noopener: a aba aberta não recebe
                    window.opener nem o endereço desta página. */}
                <a
                  className="btn btn-quiet"
                  href={OPENCODE_CONSOLE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink size={15} aria-hidden="true" />
                  Obter a chave
                </a>
              </div>

              {aberto ? (
                <div className="opencode-card-form">
                  <label className="settings-field">
                    <span>Chave do OpenCode</span>
                    <input
                      type="password"
                      value={chave}
                      onChange={(event) => setChave(event.target.value)}
                      placeholder="Cole aqui a chave copiada do console"
                      autoComplete="off"
                      spellCheck={false}
                      // Enter salva: o campo é o único do formulário, e obrigar
                      // o mouse depois de colar é atrito sem função.
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          void conectar(preset);
                        }
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void conectar(preset)}
                    disabled={!chave.trim() || salvandoId === preset.id}
                  >
                    {salvandoId === preset.id ? 'Validando…' : 'Conectar e buscar modelos'}
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
