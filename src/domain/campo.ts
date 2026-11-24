// Visitas do dia. A rota é o plano (quem atende quem, em que ordem, em que dias); a visita é
// o fato. As visitas de hoje são criadas a partir das rotas na hora em que alguém abre a tela,
// sem depender de cron.
import { and, asc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { DB, Tx } from "../db/client.js";
import { clientes, rotaParadas, rotas, servicos, usuarios, visitaItens, visitas, type Gps } from "../db/schema.js";
import { HttpError, invalido, naoEncontrado } from "../lib/erros.js";
import { paraReais } from "./dinheiro.js";

type Visita = typeof visitas.$inferSelect;

/** 0 = domingo … 6 = sábado, para uma data YYYY-MM-DD. */
export const diaDaSemana = (dia: string) => new Date(`${dia}T00:00:00Z`).getUTCDay();

const conflito = (msg: string) => new HttpError(409, msg);

/**
 * Cria as visitas do dia a partir das rotas. Idempotente: roda toda vez que a tela abre.
 * Visita pendente acompanha a rota (ordem, funcionário, parada que saiu). Visita iniciada ou
 * encerrada é fato e não muda.
 */
export async function garantirVisitas(d: DB, empresaId: string, data: string) {
  const dow = diaDaSemana(data);
  const plano = await d
    .select({ rotaId: rotas.id, funcionarioId: rotas.funcionarioId, clienteId: rotaParadas.clienteId, ordem: rotaParadas.ordem })
    .from(rotas)
    .innerJoin(rotaParadas, eq(rotaParadas.rotaId, rotas.id))
    .innerJoin(clientes, eq(clientes.id, rotaParadas.clienteId))
    .innerJoin(usuarios, eq(usuarios.id, rotas.funcionarioId))
    .where(
      and(
        eq(rotas.empresaId, empresaId),
        eq(rotas.ativo, true),
        eq(clientes.ativo, true),
        eq(usuarios.ativo, true),
        sql`${dow}::smallint = any(${rotas.dias})`,
      ),
    );

  await d.transaction(async (tx) => {
    if (plano.length)
      await tx
        .insert(visitas)
        .values(plano.map((p) => ({ ...p, empresaId, data })))
        .onConflictDoUpdate({
          target: [visitas.rotaId, visitas.clienteId, visitas.data],
          set: { ordem: sql`excluded.ordem`, funcionarioId: sql`excluded.funcionario_id`, atualizadoEm: new Date() },
          setWhere: eq(visitas.status, "pendente"),
        });
    const previstas = new Set(plano.map((p) => `${p.rotaId}|${p.clienteId}`));
    const pendentes = await tx
      .select({ id: visitas.id, rotaId: visitas.rotaId, clienteId: visitas.clienteId })
      .from(visitas)
      .where(and(eq(visitas.empresaId, empresaId), eq(visitas.data, data), eq(visitas.status, "pendente")));
    const sobra = pendentes.filter((v) => !previstas.has(`${v.rotaId}|${v.clienteId}`)).map((v) => v.id);
    if (sobra.length) await tx.delete(visitas).where(inArray(visitas.id, sobra));
  });
}

export async function listarVisitas(d: DB | Tx, empresaId: string, data: string, funcionarioId?: string) {
  const lista = await d
    .select({
      id: visitas.id,
      data: visitas.data,
      ordem: visitas.ordem,
      status: visitas.status,
      chegadaEm: visitas.chegadaEm,
      chegadaGps: visitas.chegadaGps,
      fimEm: visitas.fimEm,
      fimGps: visitas.fimGps,
      obs: visitas.obs,
      motivo: visitas.motivo,
      rotaId: visitas.rotaId,
      rotaNome: rotas.nome,
      funcionarioId: visitas.funcionarioId,
      funcionarioNome: usuarios.nome,
      clienteId: visitas.clienteId,
      clienteNome: clientes.nome,
      endereco: clientes.endereco,
      telefone: clientes.telefone,
    })
    .from(visitas)
    .innerJoin(rotas, eq(rotas.id, visitas.rotaId))
    .innerJoin(clientes, eq(clientes.id, visitas.clienteId))
    .innerJoin(usuarios, eq(usuarios.id, visitas.funcionarioId))
    .where(and(eq(visitas.empresaId, empresaId), eq(visitas.data, data), funcionarioId ? eq(visitas.funcionarioId, funcionarioId) : undefined))
    .orderBy(asc(usuarios.nome), asc(rotas.nome), asc(visitas.ordem));

  const itens = lista.length ? await d.select().from(visitaItens).where(inArray(visitaItens.visitaId, lista.map((v) => v.id))) : [];
  const porVisita = new Map<string, { servicoId: string; nome: string; valor: number }[]>();
  for (const i of itens) {
    const l = porVisita.get(i.visitaId) ?? [];
    l.push({ servicoId: i.servicoId, nome: i.nome, valor: paraReais(i.valor) });
    porVisita.set(i.visitaId, l);
  }
  return lista.map((v) => {
    const its = (porVisita.get(v.id) ?? []).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    return { ...v, itens: its, extras: its.reduce((s, i) => s + Math.round(i.valor * 100), 0) / 100 };
  });
}

/** Visita do próprio funcionário, travada para a mudança de status. */
async function minhaVisita(tx: Tx, a: { empresaId: string; funcionarioId: string; id: string; hoje: string }) {
  const [v] = await tx
    .select()
    .from(visitas)
    .where(and(eq(visitas.id, a.id), eq(visitas.empresaId, a.empresaId), eq(visitas.funcionarioId, a.funcionarioId)))
    .for("update");
  if (!v) throw naoEncontrado("Visita");
  if (v.data !== a.hoje) throw conflito("Só dá para registrar visitas de hoje.");
  return v;
}

const encerrada = (v: Visita) =>
  conflito(v.status === "concluida" ? "Esta visita já foi concluída." : "Esta visita já foi marcada como não realizada.");

type Acao = { empresaId: string; funcionarioId: string; id: string; hoje: string; gps: Gps | null };

export async function registrarChegada(tx: Tx, a: Acao) {
  const v = await minhaVisita(tx, a);
  if (v.status === "em_atendimento") return v; // toque repetido no "Cheguei"
  if (v.status !== "pendente") throw encerrada(v);
  const [outra] = await tx
    .select({ cliente: clientes.nome })
    .from(visitas)
    .innerJoin(clientes, eq(clientes.id, visitas.clienteId))
    .where(and(eq(visitas.funcionarioId, a.funcionarioId), eq(visitas.data, a.hoje), eq(visitas.status, "em_atendimento"), ne(visitas.id, v.id)));
  if (outra) throw conflito(`Conclua o atendimento em ${outra.cliente} antes de começar outro.`);
  const [r] = await tx
    .update(visitas)
    .set({ status: "em_atendimento", chegadaEm: new Date(), chegadaGps: a.gps, atualizadoEm: new Date() })
    .where(eq(visitas.id, v.id))
    .returning();
  return r!;
}

export async function concluirVisita(tx: Tx, a: Acao & { servicos: string[]; obs: string }) {
  const v = await minhaVisita(tx, a);
  if (v.status === "pendente") throw conflito("Registre a chegada no cliente antes de concluir.");
  if (v.status !== "em_atendimento") throw encerrada(v);
  const ids = [...new Set(a.servicos)];
  const cat = ids.length
    ? await tx
        .select()
        .from(servicos)
        .where(and(inArray(servicos.id, ids), eq(servicos.empresaId, a.empresaId), eq(servicos.ativo, true)))
    : [];
  if (cat.length !== ids.length) throw invalido("Algum serviço marcado foi removido. Atualize a tela e marque de novo.");
  if (cat.length) await tx.insert(visitaItens).values(cat.map((s) => ({ visitaId: v.id, servicoId: s.id, nome: s.nome, valor: s.valor })));
  const [r] = await tx
    .update(visitas)
    .set({ status: "concluida", fimEm: new Date(), fimGps: a.gps, obs: a.obs, atualizadoEm: new Date() })
    .where(eq(visitas.id, v.id))
    .returning();
  return { visita: r!, itens: cat };
}

export async function naoRealizada(tx: Tx, a: Acao & { motivo: string }) {
  const v = await minhaVisita(tx, a);
  if (v.status !== "pendente" && v.status !== "em_atendimento") throw encerrada(v);
  const [r] = await tx
    .update(visitas)
    .set({ status: "nao_realizada", fimEm: new Date(), fimGps: a.gps, motivo: a.motivo, atualizadoEm: new Date() })
    .where(eq(visitas.id, v.id))
    .returning();
  return r!;
}

/** A empresa desfaz o registro do dia (toque errado no campo). Volta a visita para pendente. */
export async function reabrirVisita(tx: Tx, a: { empresaId: string; id: string; hoje: string }) {
  const [v] = await tx
    .select()
    .from(visitas)
    .where(and(eq(visitas.id, a.id), eq(visitas.empresaId, a.empresaId)))
    .for("update");
  if (!v) throw naoEncontrado("Visita");
  if (v.data !== a.hoje) throw conflito("Só dá para reabrir visitas de hoje.");
  if (v.status === "pendente") return { antes: v, itens: [] };
  const [faturado] = await tx
    .select({ n: visitaItens.servicoId })
    .from(visitaItens)
    .where(and(eq(visitaItens.visitaId, v.id), isNotNull(visitaItens.notaId)))
    .limit(1);
  if (faturado) throw conflito("Os serviços desta visita já entraram em uma nota. Cancele a nota antes de reabrir.");
  const itens = await tx.delete(visitaItens).where(eq(visitaItens.visitaId, v.id)).returning();
  await tx
    .update(visitas)
    .set({ status: "pendente", chegadaEm: null, chegadaGps: null, fimEm: null, fimGps: null, obs: "", motivo: "", atualizadoEm: new Date() })
    .where(eq(visitas.id, v.id));
  return { antes: v, itens };
}
