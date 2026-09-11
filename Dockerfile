FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server ./server
COPY index.html instructor.html superadmin.html learner.html exam.html setup.html health.html powerpoint.html certificate.html survey.html survey-powerpoint.html office-manifest.xml office-manifest-survey.xml privacy-policy.pdf ./public/
COPY app.js superadmin.js learner.js learner-improvements.js exam.js exam-improvements.js api.js synchronized-clock.js style.css timer-pin.css timer-pin.js powerpoint.js powerpoint-improvements.js powerpoint.css certificate.js survey-admin.js survey.js survey.css survey-powerpoint.js survey-powerpoint-improvements.js lot-improvements.js lot-improvements.css ./public/

ENV NODE_ENV=production \
    PORT=3000 \
    PUBLIC_DIR=/app/public

USER node
EXPOSE 3000

CMD ["node", "server/index-with-survey.js"]
