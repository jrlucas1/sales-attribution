import { createHmac, timingSafeEqual } from 'node:crypto';

// Assinatura do webhook: HMAC-SHA256 do corpo, byte a byte como foi enviado,
// com o segredo da loja, em base64. É o formato do X-Shopify-Hmac-Sha256.
export function signBody(secret: string, body: string | Buffer): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

export function isValidSignature(secret: string, body: Buffer, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(body).digest();
  const received = Buffer.from(signature, 'base64');
  // timingSafeEqual exige o mesmo tamanho; tamanho diferente já é assinatura errada.
  return received.length === expected.length && timingSafeEqual(received, expected);
}
