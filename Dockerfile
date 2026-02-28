FROM denoland/deno:latest

WORKDIR /app

COPY deno.json .
RUN deno install

COPY . .
RUN deno check main.ts

EXPOSE 8080

CMD ["deno", "run", "--allow-net", "--allow-env", "main.ts"]
