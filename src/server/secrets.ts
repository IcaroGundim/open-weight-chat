import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Cifragem de segredos guardados no banco.
 *
 * Guardar uma chave de API em texto puro numa tabela seria pior do que a
 * postura anterior — um dump do banco, um backup ou um `SELECT` acidental
 * bastariam para vazá-la. Aqui a chave só existe em claro na memória do
 * processo, entre a requisição e a chamada ao provedor.
 *
 * A chave-mestra vem de PROVIDER_SECRET_KEY. Sem ela, guardar segredo é
 * recusado — nunca degradado para texto puro em silêncio.
 */

const VERSION = 'v1';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const MIN_MASTER_KEY_LENGTH = 16;

export interface SecretStorageStatus {
  readonly available: boolean;
  readonly reason: string | null;
}

export function getSecretStorageStatus(): SecretStorageStatus {
  const master = process.env.PROVIDER_SECRET_KEY ?? '';
  if (!master.trim()) {
    return {
      available: false,
      reason:
        'Defina PROVIDER_SECRET_KEY no ambiente do servidor para guardar chaves. Sem ela, as chaves só podem vir de variáveis de ambiente.',
    };
  }
  if (master.trim().length < MIN_MASTER_KEY_LENGTH) {
    return {
      available: false,
      reason: `PROVIDER_SECRET_KEY precisa ter ao menos ${MIN_MASTER_KEY_LENGTH} caracteres.`,
    };
  }
  return { available: true, reason: null };
}

function deriveKey(salt: Buffer): Buffer {
  const master = process.env.PROVIDER_SECRET_KEY ?? '';
  return scryptSync(master, salt, KEY_LENGTH);
}

export function encryptSecret(plain: string): string {
  const status = getSecretStorageStatus();
  if (!status.available) throw new Error(status.reason ?? 'Armazenamento de segredos indisponível.');

  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, salt, iv, tag, ciphertext].map((part) => (typeof part === 'string' ? part : part.toString('base64'))).join('.');
}

export function decryptSecret(blob: string | null | undefined): string | null {
  if (!blob) return null;
  if (!getSecretStorageStatus().available) return null;

  const parts = blob.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) return null;
  try {
    const [, saltB64, ivB64, tagB64, ctB64] = parts;
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(Buffer.from(saltB64, 'base64')), Buffer.from(ivB64, 'base64'));
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
