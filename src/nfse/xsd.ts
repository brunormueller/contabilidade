import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateXML } from "xmllint-wasm";
import type { Ambiente } from "../env.js";
import { LAYOUTS } from "./ambiente.js";

// Valida XML contra os XSD oficiais em xsd/<ambiente>. Roda antes de cada envio, para que erro
// de leiaute apareça aqui com a mensagem do schema, e não como rejeição genérica da Sefin.

type Arq = { fileName: string; contents: string };
const cache = new Map<string, Arq[]>();

function arquivos(dir: string): Arq[] {
  let a = cache.get(dir);
  if (!a) {
    const base = join(process.cwd(), "xsd", dir);
    a = readdirSync(base)
      .filter((f) => f.endsWith(".xsd"))
      .map((f) => ({
        fileName: f,
        contents: readFileSync(join(base, f), "utf8")
          // o xmldsig-core-schema traz um DOCTYPE que aponta para a web; o validador não acessa rede
          .replace(/<!DOCTYPE[\s\S]*?\]>/, "")
          // Em XSD o pattern já casa a string inteira e ^ e $ são caracteres literais. O pacote de
          // produção 20260209 usa "^0{0,4}\d{1,5}$" em TSSerieDPS, o que recusaria toda série.
          .replace(/(<xs:pattern value=")\^([^"]*)\$"/g, '$1$2"'),
      }));
    cache.set(dir, a);
  }
  return a;
}

export async function validarXsd(xml: string, ambiente: Ambiente, raiz = "DPS_v1.01.xsd") {
  const todos = arquivos(LAYOUTS[ambiente].xsdDir);
  const principal = todos.find((f) => f.fileName === raiz);
  if (!principal) throw new Error(`XSD ${raiz} não encontrado em xsd/${LAYOUTS[ambiente].xsdDir}`);
  const r = await validateXML({
    xml: [{ fileName: "documento.xml", contents: xml }],
    schema: [principal],
    preload: todos.filter((f) => f !== principal),
  });
  return { valido: r.valid, erros: r.errors.map((e) => e.message.trim()) };
}
