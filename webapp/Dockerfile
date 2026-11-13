# Cloud Run 用のコンテナ（2026-10-30）
# 自動の作り方（buildpacks）で作ったコンテナが Cloud Run に取り込めなくなったため、作り方を固定する
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["node", "server.js"]
