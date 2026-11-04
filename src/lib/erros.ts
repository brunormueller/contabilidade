import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Erro com status HTTP e mensagem segura para mostrar ao usuário. */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
    readonly detalhes?: unknown,
  ) {
    super(message);
  }
}

export const naoAutenticado = () => new HttpError(401, "Faça login para continuar.");
export const proibido = () => new HttpError(403, "Seu perfil não permite esta ação.");
export const naoEncontrado = (o = "Registro") => new HttpError(404, `${o} não encontrado.`);
export const invalido = (msg: string, detalhes?: unknown) => new HttpError(400, msg, detalhes);
