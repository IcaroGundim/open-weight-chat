import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Cifragem de segredos guardados no banco.
 *
 * A chave de API entra pela interface e só existe em claro na memória do
 * servidor durante a requisição. A chave-mestra é gerada automaticamente na
 * primeira inicialização e guardada em um arquivo local ignorado pelo Git.
 * `PROVIDER_SECRET_KEY` continua sendo aceito para instalações que já usam
 * uma chave-mestra própria, mas não é mais necessário para cadastrar nada.
 */

const VERSION = 'v1';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const MIN_MASTER_KEY_LENGTH = 16;
const DEFAULT_SECRET_FILE = '.provider-secret';

interface MasterSecretResult {
  readonly value: string | null;
  readonly reason: string | null;
}

export interface SecretStorageStatus {
  readonly available: boolean;
  readonly reason: string | null;
}

let generatedSecret: { path: string; value: string } | null = null;

function secretFilePath(): string {
  const configured = process.env.PROVIDER_SECRET_FILE?.trim();
  if (!configured) return join(process.cwd(), DEFAULT_SECRET_FILE);
  return isAbsolute(configured) ? configured : join(process.cwd(), configured);
}

function readPersistedSecret(path: string): string | null {
  try {
    const value = readFileSync(path, 'utf8').trim();
    return value.length >= MIN_MASTER_KEY_LENGTH ? value : null;
  } catch {
    return null;
  }
}

function persistSecret(path: string, value: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${value}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* Windows pode não expor POSIX mode. */ }
    return true;
  } catch {
    return false;
  }
}

function automaticMasterSecret(): MasterSecretResult {
  const path = secretFilePath();
  if (generatedSecret?.path === path) return { value: generatedSecret.value, reason: null };

  const persisted = readPersistedSecret(path);
  if (persisted) {
    generatedSecret = { path, value: persisted };
    return { value: persisted, reason: null };
  }

  const value = randomBytes(KEY_LENGTH).toString('base64url');
  // wx evita sobrescrever uma chave criada por outro processo durante a
  // primeira inicialização. O chmod é efetivo em sistemas que o suportam.
  if (persistSecret(path, value)) {
    generatedSecret = { path, value };
    return { value, reason: null };
  }

  const raced = readPersistedSecret(path);
  if (raced) {
    generatedSecret = { path, value: raced };
    return { value: raced, reason: null };
  }
  return {
    value: null,
    reason: 'Não foi possível criar o armazenamento interno das chaves. Verifique as permissões da pasta do aplicativo.',
  };
}

function masterSecret(): MasterSecretResult {
  const explicit = process.env.PROVIDER_SECRET_KEY?.trim();
  if (explicit) {
    if (explicit.length < MIN_MASTER_KEY_LENGTH) {
      return { value: null, reason: `PROVIDER_SECRET_KEY precisa ter ao menos ${MIN_MASTER_KEY_LENGTH} caracteres.` };
    }
    // Migra instalações antigas: enquanto a variável ainda existe, deixa uma
    // cópia persistente pronta para o modo totalmente configurado pela web.
    const path = secretFilePath();
    if (!readPersistedSecret(path)) persistSecret(path, explicit);
    return { value: explicit, reason: null };
  }
  return automaticMasterSecret();
}

export function getSecretStorageStatus(): SecretStorageStatus {
  const result = masterSecret();
  return { available: Boolean(result.value), reason: result.reason };
}

function deriveKey(master: string, salt: Buffer): Buffer {
  return scryptSync(master, salt, KEY_LENGTH);
}

export function encryptSecret(plain: string): string {
  const result = masterSecret();
  if (!result.value) throw new Error(result.reason ?? 'Armazenamento de segredos indisponível.');

  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(result.value, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, salt, iv, tag, ciphertext].map((part) => (typeof part === 'string' ? part : part.toString('base64'))).join('.');
}

export function decryptSecret(blob: string | null | undefined): string | null {
  if (!blob) return null;
  const result = masterSecret();
  if (!result.value) return null;

  const parts = blob.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) return null;
  try {
    const [, saltB64, ivB64, tagB64, ctB64] = parts;
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(result.value, Buffer.from(saltB64, 'base64')), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
    return plain.toString('utf8');
  } catch {
    // Chave-mestra trocada, registro corrompido ou tag inválida: trate como
    // ausência de chave. Nunca lance daqui — derrubaria o catálogo inteiro.
    return null;
  }
}

/** Comparação em tempo constante, para telas que confirmam um segredo. */
export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
