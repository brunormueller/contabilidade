// CPF e CNPJ, incluindo o CNPJ alfanumérico (IN RFB 2.229/2024): 12 posições [0-9A-Z]
// e 2 dígitos verificadores numéricos. Cada caractere vale (código ASCII - 48), então
// para CNPJ só de números o cálculo é o mesmo de sempre.

/** Tira pontuação e espaços e passa para maiúsculas. Não remove letras. */
export const normDoc = (s: unknown) =>
  String(s ?? "")
    .toUpperCase()
    .replace(/[\s./-]/g, "");

export const soDigitos = (s: unknown) => String(s ?? "").replace(/\D/g, "");

function dvMod11(base: string, pesoMax: number) {
  let t = 0;
  let p = 2;
  for (let i = base.length - 1; i >= 0; i--) {
    t += (base.charCodeAt(i) - 48) * p;
    p = p === pesoMax ? 2 : p + 1;
  }
  const r = t % 11;
  return r < 2 ? 0 : 11 - r;
}

export function cnpjComDV(base12: string) {
  const d1 = dvMod11(base12, 9);
  return base12 + d1 + dvMod11(base12 + d1, 9);
}

export function cpfComDV(base9: string) {
  const d1 = dvMod11(base9, 11);
  return base9 + d1 + dvMod11(base9 + d1, 11);
}

export function validCNPJ(c: unknown) {
  const s = normDoc(c);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(s) || /^(\d)\1{13}$/.test(s)) return false;
  return cnpjComDV(s.slice(0, 12)) === s;
}

export function validCPF(c: unknown) {
  const s = normDoc(c);
  if (!/^\d{11}$/.test(s) || /^(\d)\1{10}$/.test(s)) return false;
  return cpfComDV(s.slice(0, 9)) === s;
}

export type TipoDoc = "CNPJ" | "CPF";

/** Documento do tomador: devolve o tipo, ou null se não for CPF nem CNPJ válido. */
export function tipoDoc(c: unknown): TipoDoc | null {
  const s = normDoc(c);
  if (s.length === 14) return validCNPJ(s) ? "CNPJ" : null;
  if (s.length === 11) return validCPF(s) ? "CPF" : null;
  return null;
}

export function fmtDoc(c: unknown) {
  const s = normDoc(c);
  if (s.length === 14) return `${s.slice(0, 2)}.${s.slice(2, 5)}.${s.slice(5, 8)}/${s.slice(8, 12)}-${s.slice(12)}`;
  if (s.length === 11) return `${s.slice(0, 3)}.${s.slice(3, 6)}.${s.slice(6, 9)}-${s.slice(9)}`;
  return s;
}
