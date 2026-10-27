# FestFlow Production Container
FROM node:20-bookworm-slim

# Install system dependencies required for canvas, tesseract, and font rendering
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    fonts-liberation \
    fontconfig \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests
COPY package.json ./

# Install npm production dependencies
RUN npm install --omit=dev

# Copy application source and assets
COPY src/ ./src/
COPY config/ ./config/
COPY scripts/ ./scripts/
COPY assets/ ./assets/
COPY supabase/ ./supabase/

# Ensure directory for WhatsApp Baileys multi-auth credentials
RUN mkdir -p auth_info_baileys

VOLUME ["/app/auth_info_baileys"]

ENV NODE_ENV=production

CMD ["npm", "start"]
