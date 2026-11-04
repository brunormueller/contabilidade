import type { Perfil } from "./domain/usuarios.js";

export type UsuarioSessao = {
  id: string;
  empresaId: string;
  nome: string;
  email: string;
  perfil: Perfil;
  temFoto: boolean;
  sessaoId: string;
};

export type AppEnv = { Variables: { user: UsuarioSessao } };
