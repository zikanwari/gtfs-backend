FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY tsconfig.json ./
COPY src ./src

ENV PORT=3001

EXPOSE 3001

CMD ["npm", "start"]
