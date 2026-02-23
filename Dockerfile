FROM node:20-slim

# Instalar Python y pip
RUN apt-get update && apt-get install -y python3 python3-pip --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Instalar edge-tts
RUN pip3 install edge-tts --break-system-packages

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
