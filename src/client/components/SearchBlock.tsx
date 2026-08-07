import { useState } from 'react';
import { AlertTriangle, Globe } from 'lucide-react';
import type { MessageSearch } from '../types';

/**
 * As buscas feitas durante uma resposta.
 *
 * Fica recolhido por padrão: o que interessa de relance é *que* houve busca e
 * *o que* foi perguntado — a lista de fontes só importa quando alguém quer
 * conferir. Mas ela precisa estar ali, porque uma resposta que cita a web sem
 * dizer de onde tirou é uma resposta que não dá para checar.
 */

function dominio(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, '');
  } catch {
    return url;
  }
}

function Cartao({ busca }: { busca: MessageSearch }) {
  const [aberto, setAberto] = useState(false);
  const total = busca.results.length;

  const resumo = !busca.done
    ? 'buscando…'
    : busca.failure
      ? 'a busca falhou'
      : total === 0
        ? 'nenhum resultado'
        : `${total} ${total === 1 ? 'fonte' : 'fontes'}`;

  return (
    <div className="search-block" data-failed={busca.failure ? 'true' : undefined}>
      <button
        type="button"
        className="search-block-head"
        onClick={() => setAberto((valor) => !valor)}
        // Sem fontes para revelar, o cabeçalho não é um alvo: um botão que não
        // faz nada ao ser clicado ensina o usuário a desconfiar dos outros.
        disabled={total === 0}
        aria-expanded={total > 0 ? aberto : undefined}
      >
        {busca.failure
          ? <AlertTriangle className="search-block-icon" size={15} aria-hidden="true" />
          : <Globe className="search-block-icon" size={15} aria-hidden="true" />}
        <span className="search-block-query">{busca.query}</span>
        <span className="search-block-count num">{resumo}</span>
      </button>

      {busca.failure ? <p className="search-block-failure">{busca.failure}</p> : null}

      {aberto && total > 0 ? (
        <ol className="search-block-results">
          {busca.results.map((resultado) => (
            <li key={resultado.url}>
              <a href={resultado.url} target="_blank" rel="noreferrer noopener">
                {resultado.title}
              </a>
              <span className="search-block-source">
                {dominio(resultado.url)}
                {resultado.publishedAt ? ` · ${resultado.publishedAt}` : ''}
              </span>
              {resultado.snippet ? <p>{resultado.snippet}</p> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

export function SearchBlock({ searches }: { searches: readonly MessageSearch[] }) {
  if (searches.length === 0) return null;
  return (
    <div className="search-blocks">
      {searches.map((busca) => <Cartao key={`${busca.round}:${busca.query}`} busca={busca} />)}
    </div>
  );
}
