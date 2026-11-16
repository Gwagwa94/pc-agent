FROM node:20-alpine

WORKDIR /app

# Dependencies
COPY package.json package-lock.json* ./
RUN npm install --production=false

# Source
COPY . .

# Session DB volume
VOLUME ["/data"]

EXPOSE 8080

CMD ["npx", "tsx", "server.ts"]
