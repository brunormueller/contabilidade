// Única Vercel Function: o vercel.json reescreve /api/* para cá e o Hono roteia.
import { handle } from "hono/vercel";
import { app } from "../src/app.js";

const h = handle(app);
export const GET = h;
export const POST = h;
export const PUT = h;
export const PATCH = h;
export const DELETE = h;
export const HEAD = h;
