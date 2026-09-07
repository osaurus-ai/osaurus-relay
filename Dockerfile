# Pinned by tag AND digest so builds are reproducible and cannot be silently swapped upstream.
# Bump deliberately: `docker buildx imagetools inspect denoland/deno:<tag>` prints the digest.
FROM denoland/deno:2.4.2@sha256:467d41805c2f531a48f84dfcd1b4f9244b8ebdbd505f752011d6d1b7daacc489

WORKDIR /app

COPY deno.json deno.lock ./
RUN deno install --frozen

COPY . .
RUN deno check main.ts

EXPOSE 8080

CMD ["deno", "run", "--allow-net", "--allow-env", "main.ts"]
