// No banco: centavos e centésimos de ponto percentual (inteiros).
// Na API: reais e percentuais como número com até 2 casas, igual ao front já usa.
export const paraCentavos = (reais: number) => Math.round(reais * 100);
export const paraReais = (centavos: number) => centavos / 100;
export const pctParaInt = (pct: number) => Math.round(pct * 100);
export const intParaPct = (v: number | null) => (v == null ? null : v / 100);
