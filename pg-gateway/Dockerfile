FROM oven/bun:1-slim

WORKDIR /srv
COPY package.json ./
RUN bun install --production
COPY src/ ./src/

ENV PORT=8080
EXPOSE 8080
CMD ["bun", "src/gateway.ts"]
