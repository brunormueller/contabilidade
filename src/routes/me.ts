import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { usuarios } from "../db/schema.js";
import { invalido } from "../lib/erros.js";
import { corpo } from "../lib/http.js";
import type { AppEnv } from "../tipos.js";

// O front recorta a foto em 192 px e manda um JPEG em data URL.
const FOTO_MAX = 200 * 1024;

export const rotaMe = new Hono<AppEnv>();

rotaMe.put("/foto", async (c) => {
  const { dataUrl } = await corpo(c, z.object({ dataUrl: z.string().max(400_000) }));
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw invalido("Envie a foto como JPEG.");
  const bytes = Buffer.from(m[1]!, "base64");
  if (bytes.byteLength > FOTO_MAX) throw invalido("Foto grande demais.");
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) throw invalido("Arquivo não é um JPEG válido.");
  const d = await db();
  await d.update(usuarios).set({ foto: bytes }).where(eq(usuarios.id, c.get("user").id));
  return c.json({ ok: true });
});

rotaMe.delete("/foto", async (c) => {
  const d = await db();
  await d.update(usuarios).set({ foto: null }).where(eq(usuarios.id, c.get("user").id));
  return c.json({ ok: true });
});
