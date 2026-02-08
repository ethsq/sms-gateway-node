# ---- Stage 1: Builder ----
FROM node:18-slim AS builder

RUN apt-get update && apt-get install -y \
    libusb-1.0-0-dev \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

# ---- Stage 2: Runtime ----
FROM node:18-slim

RUN apt-get update && apt-get install -y \
    libusb-1.0-0 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package.json server.js ./

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
