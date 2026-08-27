FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server ./server
COPY index.html instructor.html learner.html setup.html health.html ./public/
COPY app.js learner.js api.js style.css ./public/

ENV NODE_ENV=production \
    PORT=3000 \
    PUBLIC_DIR=/app/public

USER node
EXPOSE 3000

CMD ["node", "server/index.js"]
