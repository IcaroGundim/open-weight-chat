/**
 * Isola os testes da configuração local de desenvolvimento.
 *
 * `providers.custom.ts` lê `providers.local.json` da raiz do projeto quando ele
 * existe. Sem esta linha, o resultado dos testes dependeria de o desenvolvedor
 * ter (ou não) provedores personalizados configurados na máquina — que é
 * exatamente o tipo de teste que passa aqui e falha na integração contínua.
 *
 * Apontamos para um caminho que não existe; testes que precisam de provedores
 * personalizados usam a variável CUSTOM_PROVIDERS, que continua sob controle deles.
 */
process.env.CUSTOM_PROVIDERS_FILE = 'providers.inexistente-para-testes.json';
