FROM node:20-alpine

WORKDIR /app

# Dependencies
COPY package.json package-lock.json* ./
RUN npm install --production=false

# Source
COPY . .

# Session DB volume
ENV DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 14000

CMD ["npx", "tsx", "server.ts"]
