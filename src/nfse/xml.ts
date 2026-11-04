// Montagem de XML por concatenação, com escape e sem caractere de controle.

const esc = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

type Filho = string | false | null | undefined;
/** Elemento com texto (escapado). Sem texto, o elemento some. */
export const t = (nome: string, v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? "" : `<${nome}>${esc(String(v))}</${nome}>`);
/** Elemento com filhos já montados. Sem filhos, some. */
export const g = (nome: string, ...f: Filho[]) => {
  const c = f.filter(Boolean).join("");
  return c ? `<${nome}>${c}</${nome}>` : "";
};
