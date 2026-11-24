// Envio de e-mail. A fila de envios só conhece este contrato; hoje o Resend implementa,
// e os testes trocam por um carteiro de mentira.
import { env } from "../env.js";

export type Anexo = { nome: string; conteudo: string; tipo: string };
export type Mensagem = {
  para: string;
  assunto: string;
  html: string;
  texto: string;
  anexos: Anexo[];
  /** mesma chave = mesmo e-mail: reenvio depois de queda não duplica */
  idempotencia: string;
};

export interface Carteiro {
  enviar(m: Mensagem): Promise<void>;
}

/** Recusa que não adianta repetir (endereço inválido, remetente não verificado...). */
export class EnvioRecusado extends Error {}

function resend(chave: string, remetente: string, responder?: string): Carteiro {
  return {
    async enviar(m) {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${chave}`, "content-type": "application/json", "idempotency-key": m.idempotencia },
        body: JSON.stringify({
          from: remetente,
          to: [m.para],
          subject: m.assunto,
          html: m.html,
          text: m.texto,
          ...(responder && { reply_to: responder }),
          attachments: m.anexos.map((a) => ({ filename: a.nome, content: Buffer.from(a.conteudo).toString("base64"), content_type: a.tipo })),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) return;
      const corpo = await r.text().catch(() => "");
      const msg = `Resend respondeu ${r.status}: ${corpo.slice(0, 300)}`;
      // 429 e 5xx passam; o resto é problema de dado ou de configuração
      if (r.status === 429 || r.status >= 500) throw new Error(msg);
      throw new EnvioRecusado(msg);
    },
  };
}

let trocado: Carteiro | null = null;

/** null quando o servidor não tem e-mail configurado. */
export function carteiro(): Carteiro | null {
  if (trocado) return trocado;
  const e = env();
  return e.RESEND_API_KEY && e.EMAIL_REMETENTE ? resend(e.RESEND_API_KEY, e.EMAIL_REMETENTE, e.EMAIL_RESPONDER_PARA) : null;
}

/** Só para testes. */
export function usarCarteiro(c: Carteiro | null) {
  trocado = c;
}
