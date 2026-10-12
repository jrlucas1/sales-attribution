// Valor decimal como o Shopify envia: "199.90", "50", "0.5".
export const MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

export function toCents(value: string): number {
  if (!MONEY_PATTERN.test(value)) {
    throw new Error(`valor monetário inválido: ${value}`);
  }
  const [whole = '0', fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
