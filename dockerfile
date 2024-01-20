FROM node:20.11.0-alpine3.19

ENV MODE DEVELOPMENT
ENV NODE_COUNT 0

WORKDIR /app

COPY package.json test_entrypoint.ts ./

ADD src ./src

RUN npm install npm@10.3.0 && npm install

CMD ["node", "--import", "tsx", "test_entrypoint.ts"]
