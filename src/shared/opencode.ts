/**
 * Dados do OpenCode que servidor e navegador precisam dizer igual.
 *
 * A tela de conexão precisa da URL base para pré-preencher o cadastro, e o
 * servidor precisa dela para reconhecer o gateway e filtrar o catálogo por
 * protocolo (src/server/opencode.ts). Duas cópias divergiriam em silêncio: a
 * tela salvaria um endereço que o servidor não reconheceria, e o filtro
 * simplesmente não rodaria. Um teste amarra estes valores ao catálogo.
 *
 * **Não existe OAuth aqui, e não é por falta de tentativa.** O OpenCode não
 * publica fluxo de autorização para aplicações de terceiros: o acesso
 * programático ao Zen e ao Go é por chave de API, obtida no console deles.
 * É o mesmo caminho que os outros clientes usam — o Zed, por exemplo, também
 * não faz login por OAuth no OpenCode, e lê a chave do keychain ou de
 * OPENCODE_API_KEY. O que dá para fazer, e é o que está feito, é encurtar o
 * trajeto: abrir o console na aba certa e validar a chave na hora em que ela
 * é colada, para o usuário não descobrir um erro de digitação no meio de uma
 * conversa.
 */

/** Console do OpenCode: onde se assina o Go e se copia a chave dos dois. */
export const OPENCODE_CONSOLE_URL = 'https://opencode.ai/auth';

export interface OpenCodePreset {
  readonly id: 'opencode' | 'opencode-go';
  readonly label: string;
  readonly baseURL: string;
  /** Como o plano cobra — é o que decide a escolha entre os dois. */
  readonly billing: string;
  readonly description: string;
}

export const OPENCODE_PRESETS: readonly OpenCodePreset[] = [
  {
    id: 'opencode',
    label: 'OpenCode Zen',
    baseURL: 'https://opencode.ai/zen/v1',
    billing: 'Pré-pago, por uso',
    description:
      'Catálogo amplo, cobrado por token com créditos na conta. Inclui modelos gratuitos.',
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    baseURL: 'https://opencode.ai/zen/go/v1',
    billing: 'Assinatura mensal',
    description:
      'Seleção menor de modelos de código, com preço por token mais baixo que o Zen nos mesmos modelos.',
  },
];

/** A mesma chave serve aos dois — é assim que o OpenCode funciona. */
export const OPENCODE_API_KEY_ENV = 'OPENCODE_API_KEY';
