import { describe, expect, it } from 'vitest';
import { filterOpenCodeModels, openCodeCatalogFor } from './opencode';
import { PROVIDERS } from './providers.config';
import { OPENCODE_API_KEY_ENV, OPENCODE_PRESETS } from '../shared/opencode';
import type { ProviderModelInput } from '../shared/types';

describe('reconhecimento do gateway OpenCode', () => {
  it('separa Zen de Go pelo caminho, testando o prefixo mais longo primeiro', () => {
    // `/zen/go/v1` começa com `/zen/`, então a ordem dos testes importa: na
    // ordem ingênua, todo endereço do Go seria lido como Zen — e o Go tem
    // catálogo e preços próprios.
    expect(openCodeCatalogFor('https://opencode.ai/zen/v1')).toBe('opencode');
    expect(openCodeCatalogFor('https://opencode.ai/zen/go/v1')).toBe('opencode-go');
    expect(openCodeCatalogFor('https://opencode.ai/zen/go/v1/')).toBe('opencode-go');
  });

  it('não reconhece host de terceiro, nem quando o caminho imita o do OpenCode', () => {
    expect(openCodeCatalogFor('https://gateway.exemplo.com/zen/v1')).toBeNull();
    // Sufixo parecido não é o mesmo domínio.
    expect(openCodeCatalogFor('https://naoopencode.ai/zen/v1')).toBeNull();
    expect(openCodeCatalogFor('https://opencode.ai.exemplo.com/zen/v1')).toBeNull();
    expect(openCodeCatalogFor('nao-e-url')).toBeNull();
  });

  it('exige https', () => {
    expect(openCodeCatalogFor('http://opencode.ai/zen/v1')).toBeNull();
  });

  it('ignora caminho do OpenCode que não seja um dos dois catálogos', () => {
    expect(openCodeCatalogFor('https://opencode.ai/docs')).toBeNull();
  });
});

describe('filtro de modelos do OpenCode', () => {
  function descoberto(id: string): ProviderModelInput {
    // Forma real do /models deles: id e nada mais. Sem preço, sem janela.
    return { id, ctx: 0 };
  }

  it('descarta os modelos servidos por outro protocolo', () => {
    // claude-* responde em /messages e gpt-* em /responses. Aceitá-los daria
    // ao usuário opções que falham em toda mensagem.
    const filtrados = filterOpenCodeModels('opencode', [
      descoberto('claude-opus-5'),
      descoberto('gpt-5.5'),
      descoberto('gemini-3.6-flash'),
      descoberto('deepseek-v4-flash'),
    ]);
    expect(filtrados.map((model) => model.id)).toEqual(['deepseek-v4-flash']);
  });

  it('enriquece com janela e preço, que o /models do OpenCode não informa', () => {
    const [modelo] = filterOpenCodeModels('opencode', [descoberto('deepseek-v4-flash')]);
    expect(modelo.ctx).toBeGreaterThan(0);
    // Sem isto, todo modelo entraria sem preço e o custo apareceria como
    // indisponível para quem usa o OpenCode.
    expect(modelo.pricing?.inputPerMillion).toBe(0.14);
  });

  it('respeita a divergência de catálogo entre Zen e Go para o mesmo id', () => {
    // `minimax-m3` é /chat/completions no Zen e /messages no Go; `grok-4.5` é
    // o inverso. Uma regra por prefixo erraria nos dois.
    const noZen = filterOpenCodeModels('opencode', [descoberto('minimax-m3'), descoberto('grok-4.5')]);
    expect(noZen.map((model) => model.id)).toEqual(['minimax-m3']);

    const noGo = filterOpenCodeModels('opencode-go', [descoberto('minimax-m3'), descoberto('grok-4.5')]);
    expect(noGo.map((model) => model.id)).toEqual(['grok-4.5']);
  });

  it('cobra preço diferente do mesmo modelo em cada assinatura', () => {
    // O Go é assinatura e sai mais barato no mesmo id; usar o preço do Zen
    // para uma conversa atendida pelo Go faria o custo mentir para cima.
    const zen = filterOpenCodeModels('opencode', [descoberto('deepseek-v4-pro')])[0];
    const go = filterOpenCodeModels('opencode-go', [descoberto('deepseek-v4-pro')])[0];
    expect(zen.pricing?.inputPerMillion).not.toBe(go.pricing?.inputPerMillion);
  });

  it('não duplica quando o provedor repete um id', () => {
    const filtrados = filterOpenCodeModels('opencode', [descoberto('kimi-k3'), descoberto('kimi-k3')]);
    expect(filtrados).toHaveLength(1);
  });

  it('devolve vazio quando nada do catálogo vivo é dirigível', () => {
    // A rota traduz isso numa mensagem que diz que a chave está certa e o
    // catálogo é que mudou — senão o usuário recadastra uma chave válida.
    expect(filterOpenCodeModels('opencode', [descoberto('claude-opus-5')])).toEqual([]);
  });
});

describe('catálogo embutido do OpenCode', () => {
  it('lista apenas modelos com preço conhecido ou preço explicitamente ausente', () => {
    // Preço ausente vira null (exibido como indisponível), nunca zero: zero
    // seria uma medição errada, não uma medição faltando.
    for (const provider of [PROVIDERS.opencode, PROVIDERS['opencode-go']]) {
      for (const model of provider.models) {
        const { inputPerMillion, outputPerMillion } = model.pricing;
        expect(inputPerMillion === null || inputPerMillion >= 0).toBe(true);
        expect(outputPerMillion === null || outputPerMillion >= 0).toBe(true);
        expect(model.ctx).toBeGreaterThan(0);
      }
    }
  });

  it('usa a mesma variável de chave nos dois, que é como o OpenCode funciona', () => {
    expect(PROVIDERS.opencode.apiKeyEnv).toBe(OPENCODE_API_KEY_ENV);
    expect(PROVIDERS['opencode-go'].apiKeyEnv).toBe(OPENCODE_API_KEY_ENV);
  });

  it('mantém os presets da tela de conexão colados no catálogo', () => {
    // A tela pré-preenche o cadastro com a baseURL do preset e o servidor
    // reconhece o gateway por essa mesma URL. Se as duas divergirem, a conexão
    // salva um endereço que o filtro de protocolo não reconhece — e o usuário
    // recebe modelos que falham, sem nenhum erro no caminho.
    for (const preset of OPENCODE_PRESETS) {
      expect(PROVIDERS[preset.id].baseURL).toBe(preset.baseURL);
      expect(openCodeCatalogFor(preset.baseURL)).toBe(preset.id);
    }
  });
});
