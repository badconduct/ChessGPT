FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/badconduct/ChessGPT" \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.licenses="GPL-3.0-only"
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --chown=node:node LICENSE ./LICENSE
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=3080
EXPOSE 3080
CMD ["node", "server.js"]
