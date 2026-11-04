// Cria a empresa (se ainda não existir) e um usuário com perfil "empresa".
// Uso: npm run criar-admin -- --cnpj 11.222.333/0001-81 --razao "Minha Empresa Ltda" --nome "Fulano" --email fulano@empresa.com.br
// A senha é pedida no terminal, sem eco. Para automação, use a variável ADMIN_SENHA.
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { conectar } from "../src/db/client.js";
import { criarEmpresaEAdmin } from "../src/domain/setup.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Defina DATABASE_URL.");

const { values } = parseArgs({
  options: {
    cnpj: { type: "string" },
    razao: { type: "string", default: "" },
    nome: { type: "string" },
    email: { type: "string" },
  },
});
if (!values.nome || !values.email) {
  console.error("Informe --nome e --email (e --cnpj, se a empresa ainda não existe).");
  process.exit(1);
}

function perguntarSenha(rotulo: string): Promise<string> {
  return new Promise((ok) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const saida = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    rl.question(rotulo, (s) => {
      rl.close();
      process.stdout.write("\n");
      ok(s);
    });
    saida._writeToOutput = (s: string) => {
      if (s.startsWith(rotulo)) saida.output.write(rotulo);
    };
  });
}

const senha = process.env.ADMIN_SENHA ?? (await perguntarSenha("Senha: "));
if (!process.env.ADMIN_SENHA && senha !== (await perguntarSenha("Repita a senha: "))) {
  console.error("As senhas não conferem.");
  process.exit(1);
}

const d = await conectar(url);
const r = await criarEmpresaEAdmin(d, { cnpj: values.cnpj, razao: values.razao, nome: values.nome, email: values.email, senha });
console.log(`Usuário ${r.email} criado (empresa ${r.empresaId}).`);
process.exit(0);
