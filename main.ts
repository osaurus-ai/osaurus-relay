import { handleRequest } from "./src/router.ts";

const PORT = parseInt(Deno.env.get("PORT") ?? "8080");

Deno.serve({ port: PORT }, handleRequest);
