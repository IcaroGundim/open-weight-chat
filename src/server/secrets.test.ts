import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptSecret, encryptSecret, isV2Blob, reencryptSecret, type SecretContext } from './secrets';

/**
 * Chave-mestra de teste: o módulo é stateless em relação a ela (lê a env em
 * cada chamada), então basta setar PROVIDER_SECRET_KEY. PROVIDER_SECRET_FILE
 * aponta para um arquivo temporário para o masterSecret() não persistir a
 * chave no .provider-secret do repositório durante os testes.
 */
const MASTER = 'chave-mestra-de-teste-bem-longa';
const C1: SecretContext = { userId: 'u1', providerId: 'p1' };
const C2: SecretContext = { userId: 'u2', providerId: 'p1' };
const C3: SecretContext = { userId: 'u1', providerId: 'p2' };

let secretFile: string;

beforeEach(() => {
  secretFile = join(tmpdir(), `secrets-v2-${randomUUID()}.secret`);
  process.env.PROVIDER_SECRET_KEY = MASTER;
  process.env.PROVIDER_SECRET_FILE = secretFile;
});

afterEach(() => {
  delete process.env.PROVIDER_SECRET_KEY;
  delete process.env.PROVIDER_SECRET_FILE;
  rmSync(secretFile, { force: true });
});

/**
 * Implementação inline do formato v1 (a versão antiga do secrets.ts):
 * scrypt + AES-256-GCM SEM AAD, blob `v1.salt.iv.tag.ciphertext` em base64.
 * Usada para provar que blobs v1 já gravados continuam decifrando.
 */
function buildV1Blob(plain: string, master: string = MASTER): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(master, salt, 32), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', salt, iv, tag, ciphertext].map((part) => part.toString('base64')).join('.');
}

describe('formato v2 (AAD do dono)', () => {
  it('roundtrip com o mesmo contexto devolve o texto original', () => {
    const blob = encryptSecret('sk-secreto', C1);
    expect(blob).toMatch(/^v2\./);
    expect(decryptSecret(blob, C1)).toBe('sk-secreto');
  });

  it('roundtrip com contexto diferente devolve null (AAD não bate)', () => {
    const blob = encryptSecret('sk-secreto', C1);
    // Mesmo provedor, outro usuário.
    expect(decryptSecret(blob, C2)).toBeNull();
    // Mesmo usuário, outro provedor.
    expect(decryptSecret(blob, C3)).toBeNull();
  });

  it('sem contexto, o v2 usa AAD vazio — compatível com os call sites atuais', () => {
    const blob = encryptSecret('sk-secreto');
    expect(blob).toMatch(/^v2\./);
    expect(decryptSecret(blob)).toBe('sk-secreto');
    // Um blob sem dono não pode ser lido com contexto (AAD vazio ≠ u1:p1).
    expect(decryptSecret(blob, C1)).toBeNull();
  });

  it('blob v2 com contexto não pode ser lido sem contexto', () => {
    const blob = encryptSecret('sk-secreto', C1);
    expect(decryptSecret(blob)).toBeNull();
  });
});

describe('compatibilidade com o formato v1', () => {
  it('blob v1 construído manualmente decifra com e sem contexto', () => {
    const blob = buildV1Blob('sk-antigo');
    expect(blob).toMatch(/^v1\./);
    // v1 ignora o contexto (não tem AAD) — necessário para a migração.
    expect(decryptSecret(blob)).toBe('sk-antigo');
    expect(decryptSecret(blob, C1)).toBe('sk-antigo');
    expect(decryptSecret(blob, C2)).toBe('sk-antigo');
  });

  it('encryptSecret continua gerando blobs legíveis pelo formato v1 antigo (sem AAD)', () => {
    // Um decifrador v1 "puro" (sem setAAD) precisa ler o que o v2 sem
    // contexto gravou: AAD vazio não altera o GCM.
    const blob = encryptSecret('sk-secreto');
    const [saltB64, ivB64, tagB64, ctB64] = blob.split('.').slice(1);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      scryptSync(MASTER, Buffer.from(saltB64, 'base64'), 32),
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
    expect(plain.toString('utf8')).toBe('sk-secreto');
  });
});

describe('isV2Blob', () => {
  it('reconhece o prefixo v2', () => {
    expect(isV2Blob(encryptSecret('x'))).toBe(true);
    expect(isV2Blob(encryptSecret('x', C1))).toBe(true);
    expect(isV2Blob('v2.qualquer.coisa')).toBe(true);
  });

  it('rejeita blobs v1 e lixo', () => {
    expect(isV2Blob(buildV1Blob('x'))).toBe(false);
    expect(isV2Blob('v1.salt.iv.tag.ct')).toBe(false);
    expect(isV2Blob('garbage')).toBe(false);
    expect(isV2Blob('v3.salt.iv.tag.ct')).toBe(false);
  });
});

describe('reencryptSecret', () => {
  it('migra v1 → v2 e amarra ao novo contexto', () => {
    const v1 = buildV1Blob('sk-antigo');
    const v2 = reencryptSecret(v1, C1, C1);
    expect(isV2Blob(v2)).toBe(true);
    // O fromContext é irrelevante para v1; o toContext vale a partir de agora.
    expect(decryptSecret(v2, C1)).toBe('sk-antigo');
    expect(decryptSecret(v2)).toBeNull();
    expect(decryptSecret(v2, C2)).toBeNull();
  });

  it('v2 → v2 troca o AAD (transferência entre donos)', () => {
    const v2 = encryptSecret('sk-secreto', C1);
    const moved = reencryptSecret(v2, C1, C2);
    expect(isV2Blob(moved)).toBe(true);
    expect(decryptSecret(moved, C2)).toBe('sk-secreto');
    // O dono antigo perdeu o acesso.
    expect(decryptSecret(moved, C1)).toBeNull();
  });

  it('lança quando o blob não pode ser decifrado com o contexto de origem', () => {
    const v2 = encryptSecret('sk-secreto', C1);
    // Contexto errado: a migração precisa abortar, nunca seguir com lixo.
    expect(() => reencryptSecret(v2, C2, C3)).toThrow(/Não foi possível decifrar a chave antiga/);
  });

  it('lança com blob corrompido ou desconhecido', () => {
    expect(() => reencryptSecret('v2.lixo', C1, C2)).toThrow(/Não foi possível decifrar a chave antiga/);
    expect(() => reencryptSecret('garbage', C1, C2)).toThrow(/Não foi possível decifrar a chave antiga/);
    // Corrompe a tag: base64 válido (16 bytes), mas tag errada → GCM falha.
    const tamperedParts = encryptSecret('sk-secreto', C1).split('.');
    tamperedParts[3] = Buffer.alloc(16).toString('base64');
    expect(() => reencryptSecret(tamperedParts.join('.'), C1, C2)).toThrow(/Não foi possível decifrar a chave antiga/);
  });
});

describe('entradas inválidas em decryptSecret', () => {
  it('nunca lança e devolve null para blobs inválidos', () => {
    expect(decryptSecret(null)).toBeNull();
    expect(decryptSecret(undefined)).toBeNull();
    expect(decryptSecret('')).toBeNull();
    expect(decryptSecret('garbage')).toBeNull();
    expect(decryptSecret('v1.a.b.c')).toBeNull(); // 4 partes
    expect(decryptSecret('v3.salt.iv.tag.ct')).toBeNull(); // versão desconhecida
    expect(decryptSecret('v1.!!!.!!!.!!!.!!!')).toBeNull(); // base64 inválida
    expect(decryptSecret('v2.!!!.!!!.!!!.!!!', C1)).toBeNull();
  });

  it('não decifra com outra chave-mestra', () => {
    const blob = encryptSecret('sk-secreto', C1);
    process.env.PROVIDER_SECRET_KEY = 'outra-chave-mestra-diferente';
    expect(decryptSecret(blob, C1)).toBeNull();
  });
});
