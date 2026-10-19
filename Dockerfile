# opencode2dsh Railway server — zero dependencies, TypeScript runs natively.
# Build context = this directory (the whole railway-server folder is uploaded).
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.ts ./
COPY proxy.ts ./
COPY adapter/ ./adapter/

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Railway injects PORT; the process also falls back to 8080 internally.
CMD ["node", "server.ts"]
