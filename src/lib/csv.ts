// CSV no formato que o Excel brasileiro abre direto: BOM UTF-8, separador ";" e CRLF.
// Texto que começa com = + @ ou - (sem ser número) ganha um apóstrofo, contra injeção de fórmula.

const NUMERO = /^-?\d[\d.,]*$/;

function celula(v: unknown) {
  let s = String(v ?? "");
  if (/^[=+@\t\r-]/.test(s) && !NUMERO.test(s)) s = "'" + s;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csv = (linhas: unknown[][]) => "﻿" + linhas.map((l) => l.map(celula).join(";")).join("\r\n");

export const dec = (reais: number) => reais.toFixed(2).replace(".", ",");
