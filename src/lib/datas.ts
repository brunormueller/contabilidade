// Datas de calendário (YYYY-MM-DD) no fuso de Jaraguá do Sul. O servidor roda em UTC.
const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });

export const hojeBR = (agora = new Date()) => fmt.format(agora);

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

export function addDias(dia: string, n: number) {
  const [y, m, d] = dia.split("-").map(Number);
  return iso(new Date(Date.UTC(y!, m! - 1, d! + n)));
}

/** Soma meses mantendo o dia, ou o último dia do mês quando ele não existe (31/01 + 1 = 28/02). */
export function addMeses(dia: string, n: number) {
  const [y, m, d] = dia.split("-").map(Number);
  const alvo = new Date(Date.UTC(y!, m! - 1 + n, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(d!, ultimo));
  return iso(alvo);
}

export const DIA = /^\d{4}-\d{2}-\d{2}$/;
export const MES = /^\d{4}-\d{2}$/;

export function diaValido(s: string) {
  if (!DIA.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d!));
  return t.getUTCMonth() === m! - 1 && t.getUTCDate() === d;
}

export function fimDoMes(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  return iso(new Date(Date.UTC(y!, m!, 0)));
}

export const fmtDataBR = (s: string | null | undefined) => (s ? s.slice(0, 10).split("-").reverse().join("/") : "");
