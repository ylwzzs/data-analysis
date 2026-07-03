FROM caj9ik14016wep.xuanyuan.run/library/node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production --registry=https://registry.npmmirror.com

COPY . .

EXPOSE 9000
CMD ["node", "server.js"]
